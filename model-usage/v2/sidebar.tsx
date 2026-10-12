/** @jsxImportSource @opentui/solid */
/**
 * model-usage — v2 usage sidebar.
 *
 * Reads the OpenCode 2.0.27 TUI data API (`context.data`) reactively instead of
 * the v1 `api.state`/`api.client` pair: session model, session family, message
 * list, and model pricing all come from the host's projected stores. Token/cost
 * math lives in the pure `sidebar-domain` module.
 *
 * Cost estimation + provider quota (GitHub Copilot, opencode-go) are unchanged
 * from v1 apart from the data source. Quota refreshes on an interval and on
 * session compaction, mirroring the v1 behaviour.
 */

import type { Plugin } from "@opencode/plugin/tui"
import type { WlibHost } from "../wlib/src/host/types"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { CopilotQuotaInfo, GoQuotaBar, GoQuotaInfo } from "../types"
import { log as logFn } from "../helpers/debug"
import { isCopilotModel, isOpencodeGoModel, buildUsageHeaderLabel, type ActiveModelInfo } from "../helpers/model"
import { buildProgressBar, getUsageColor, getQuotaLabel, formatDuration } from "../helpers/format"
import { projectBurnRate, MIN_ELAPSED_DAYS } from "../helpers/projection"
import { getDaysInMonth, getDayOfMonth, getMonthEndLabel } from "../helpers/dates"
import { fetchQuotaInfo, fetchGoQuota, getGoAuth, withGuard } from "../quota"
import { PLUGIN_VERSION } from "../version"
import { toLegacyMessages } from "./message-adapter"
import { toPricing, computeSidebarTotals, sumSidebarTotals, type SidebarTotals } from "./sidebar-domain"

const log = logFn

const QUOTA_REFRESH_MS = 5 * 60 * 1000
const QUOTA_EVENT_MIN_INTERVAL_MS = 2 * 60 * 1000 // min gap between event-driven fetches

log(`=== usage-sidebar(v2) v${PLUGIN_VERSION} loaded ===`)

/** Resolve the active model for display: session model → prompt model → last assistant. */
function getActiveModel(
  context: Plugin.Context,
  sessionID: string,
): ActiveModelInfo | null {
  try {
    const session = context.data.session.get(sessionID)
    const sessionModel = session?.model
    if (sessionModel) {
      return { providerID: sessionModel.providerID, modelID: sessionModel.id }
    }
    const prompt = context.ui.model.current()
    if (prompt) {
      return { providerID: prompt.providerID, modelID: prompt.modelID }
    }
    const messages = context.data.session.message.list(sessionID) ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { type?: string; model?: { providerID: string; id: string } }
      if (m.type === "assistant" && m.model) {
        return { providerID: m.model.providerID, modelID: m.model.id }
      }
    }
  } catch (err) {
    log("getActiveModel error:", String(err))
  }
  return null
}

// ─── Quota fetching hook ──────────────────────────────────────────────────────

function useQuotaFetching(props: {
  githubToken: string
  hasToken: boolean
  currentModel: () => string | null
  currentProvider: () => string | null
}) {
  const [quotaInfo, setQuotaInfo] = createSignal<CopilotQuotaInfo | null>(null)
  const [quotaLoading, setQuotaLoading] = createSignal<boolean>(false)
  const [goQuota, setGoQuota] = createSignal<GoQuotaInfo | null>(null)
  const [goQuotaLoading, setGoQuotaLoading] = createSignal(false)

  let lastQuotaFetchAt = 0

  const guardedFetchQuota = withGuard(async () => {
    if (!props.hasToken) {
      log("fetchQuota: no GITHUB_TOKEN set")
      setQuotaInfo(null)
      setQuotaLoading(false)
      return
    }
    lastQuotaFetchAt = Date.now()
    if (!quotaInfo()) setQuotaLoading(true)
    try {
      const info = await fetchQuotaInfo(props.githubToken)
      setQuotaInfo(info)
    } finally {
      setQuotaLoading(false)
    }
  })

  const guardedFetchGoQuota = withGuard(async () => {
    setGoQuotaLoading(true)
    try {
      const info = await fetchGoQuota()
      setGoQuota(info)
    } finally {
      setGoQuotaLoading(false)
    }
  })

  const isCopilotActive = createMemo(() => isCopilotModel(props.currentModel() ?? "") || isCopilotModel(props.currentProvider() ?? ""))
  const isOpenCodeGoActive = createMemo(() => isOpencodeGoModel(props.currentModel() ?? "") || isOpencodeGoModel(props.currentProvider() ?? ""))

  const refreshInterval = setInterval(() => {
    if (isCopilotActive()) guardedFetchQuota()
  }, QUOTA_REFRESH_MS)

  const goRefreshInterval = setInterval(() => {
    if (isOpenCodeGoActive()) guardedFetchGoQuota()
  }, QUOTA_REFRESH_MS)

  onCleanup(() => {
    clearInterval(refreshInterval)
    clearInterval(goRefreshInterval)
  })

  return {
    quotaInfo, quotaLoading, goQuota, goQuotaLoading,
    fetchQuota: guardedFetchQuota,
    fetchGoQuotaGuarded: guardedFetchGoQuota,
    getLastQuotaFetchAt: () => lastQuotaFetchAt,
    isCopilotActive, isOpenCodeGoActive,
  }
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

function renderProjectionLine(usedPct: number, muted: string) {
  if (usedPct <= 0) return null
  const elapsedDays = getDayOfMonth()
  const totalDays = getDaysInMonth()
  const endLabel = getMonthEndLabel()
  if (elapsedDays < MIN_ELAPSED_DAYS) {
    const n = MIN_ELAPSED_DAYS - elapsedDays
    return <text fg={muted}>calculating projection... {n} {n === 1 ? "day" : "days"} to show</text>
  }
  const proj = projectBurnRate(usedPct, elapsedDays, totalDays)
  return proj ? <text fg={proj.pct > 100 ? "#ef4444" : "#22c55e"}>{Math.round(proj.pct)}% projected by {endLabel}</text> : null
}

/**
 * Render a single Go quota window. A missing window (null bar) is shown as
 * explicitly unavailable — never as a fake `0%` with an empty bar.
 */
function GoQuotaWindow(props: { label: string; bar: GoQuotaBar | null; muted: string }) {
  if (!props.bar) {
    return (
      <>
        <text fg={props.muted}>{props.label}</text>
        <text fg="#888888">Unavailable</text>
      </>
    )
  }
  const color = getUsageColor(props.bar.usagePercent)
  return (
    <>
      <text fg={props.muted}>{props.label}</text>
      <text fg={color}>
        {props.bar.usagePercent}% · resets in {formatDuration(props.bar.resetInSec)}
      </text>
      <text fg={color}>{buildProgressBar(props.bar.usagePercent)}</text>
    </>
  )
}

function UsageSidebar(props: { context: Plugin.Context; host: WlibHost; session_id: string }) {
  log("UsageSidebar(v2): rendering! session_id:", props.session_id)
  const githubToken = process.env.GITHUB_TOKEN ?? ""
  const hasToken = !!githubToken
  const hasGoAuth = getGoAuth() !== null

  const activeModelInfo = createMemo(() => getActiveModel(props.context, props.session_id))
  const currentModel = createMemo(() => activeModelInfo()?.modelID ?? null)

  // Per-session token/cost totals recomputed reactively from the v2 data API.
  const totals = createMemo<SidebarTotals>(() => {
    const pricing = toPricing(props.context.data.location.model.list(props.context.location))
    const family = props.context.data.session.family(props.session_id)
    const ids = family.length > 0 ? family : [props.session_id]
    const perSession = ids.map((id) =>
      computeSidebarTotals(toLegacyMessages(props.context.data.session.message.list(id) ?? []), pricing),
    )
    return sumSidebarTotals(perSession)
  })

  const {
    quotaInfo, quotaLoading, goQuota, goQuotaLoading,
    fetchQuota, fetchGoQuotaGuarded,
    getLastQuotaFetchAt,
    isCopilotActive, isOpenCodeGoActive,
  } = useQuotaFetching({
    githubToken,
    hasToken,
    currentModel,
    currentProvider: () => activeModelInfo()?.providerID ?? null,
  })

  // Quota refresh on session compaction (root session only) + once per session.
  let loadedQuotaSessionID: string | null = null
  let loadedGoQuotaSessionID: string | null = null

  onMount(() => {
    const sessionID = props.session_id
    if (!sessionID) return
    const info = activeModelInfo()
    const model = info?.modelID ?? null
    const provider = info?.providerID ?? null
    const isCopilot = isCopilotModel(model ?? "") || isCopilotModel(provider ?? "")
    const isGo = isOpencodeGoModel(model ?? "") || isOpencodeGoModel(provider ?? "")
    if (model) {
      if (isCopilot && loadedQuotaSessionID !== sessionID) {
        fetchQuota()
        loadedQuotaSessionID = sessionID
      }
      if (isGo && loadedGoQuotaSessionID !== sessionID) {
        loadedGoQuotaSessionID = sessionID
        fetchGoQuotaGuarded()
      }
    }

    const offCompaction = props.context.data.on("session.compaction.started", (event) => {
      const evtSID = (event as { data?: { sessionID?: string } }).data?.sessionID
      if (evtSID !== sessionID) return
      if (isCopilot && Date.now() - getLastQuotaFetchAt() > QUOTA_EVENT_MIN_INTERVAL_MS) {
        fetchQuota()
      }
    })
    onCleanup(offCompaction)
  })

  const usagePercentage = createMemo(() => {
    const quota = quotaInfo()
    if (!quota || quota.unlimited) return 0
    const used = quota.entitlement * (1 - quota.percentRemaining / 100) + quota.overageCount
    if (quota.entitlement === 0) return 0
    return (used / quota.entitlement) * 100
  })

  const usageColor = createMemo(() => getUsageColor(usagePercentage()))
  const hasActiveModel = createMemo(() => !!activeModelInfo())

  const providerLabel = createMemo(() => {
    const info = activeModelInfo()
    if (!info) return "Usage"
    return buildUsageHeaderLabel(info.providerID, info.modelID)
  })

  const cacheHitRate = createMemo(() => {
    const cacheRead = totals().cacheRead
    const nonCached = totals().nonCachedInput
    const total = cacheRead + nonCached
    if (total === 0) return null
    return Math.round((cacheRead / total) * 100)
  })

  const { fg, muted } = props.host.theme()

  return (
    <box flexDirection="column" gap={0}>
      {hasActiveModel() ? (
        <>
          <text fg={fg}><strong>{providerLabel()}</strong></text>
          <text fg={muted}>Cost estimation</text>
          <text fg="#ffffff">{("↑ " + totals().peakInputTokens.toLocaleString() + " tokens").padEnd(26) + "$" + totals().inputCost.toFixed(2)}</text>
          <text fg="#ffffff">{("↓ " + totals().outputTokens.toLocaleString() + " tokens").padEnd(26) + "$" + totals().outputCost.toFixed(2)}</text>
          {cacheHitRate() !== null ? (
            <text fg="#ffffff">{cacheHitRate() + "% cache hit"}</text>
          ) : null}
          <text fg={fg}>
            {"Total".padEnd(26) + "$" + (totals().inputCost + totals().outputCost).toFixed(2)}
          </text>
          {isCopilotActive() ? (
            <>
              <text fg={muted}>Monthly quota</text>
              {!hasToken ? (
                <text fg="#eab308">No token provided (set GITHUB_TOKEN)</text>
              ) : quotaInfo()?.unlimited ? (
                <text fg="#22c55e">Unlimited</text>
              ) : quotaInfo() ? (
                <box flexDirection="column" gap={0}>
                  <text fg={usageColor()}>{usagePercentage().toFixed(1)}% used</text>
                  <text fg={usageColor()}>{buildProgressBar(usagePercentage())}</text>
                  <text fg="#ffffff">
                    {(quotaInfo()!.entitlement - quotaInfo()!.remaining).toLocaleString()} / {quotaInfo()!.entitlement.toLocaleString()} {getQuotaLabel(quotaInfo()!)}
                  </text>
                  {renderProjectionLine(usagePercentage(), muted)}
                </box>
              ) : !quotaInfo() && quotaLoading() ? (
                <text fg="#888888">Loading...</text>
              ) : (
                <text fg="#888888">Unable to fetch quota</text>
              )}
            </>
          ) : isOpenCodeGoActive() ? (
            <>
              <text fg={muted}>Quota</text>
              {!goQuota() && goQuotaLoading() ? (
                <text fg="#888888">Loading...</text>
              ) : goQuota() ? (
                <box flexDirection="column" gap={0}>
                  <GoQuotaWindow label="Rolling (5h)" bar={goQuota()!.rolling} muted={muted} />
                  <GoQuotaWindow label="Weekly" bar={goQuota()!.weekly} muted={muted} />
                  <GoQuotaWindow label="Monthly" bar={goQuota()!.monthly} muted={muted} />
                  {goQuota()!.monthly ? renderProjectionLine(goQuota()!.monthly!.usagePercent, muted) : null}
                </box>
              ) : (
                <box flexDirection="column" gap={0}>
                  <text fg="#888888">
                    {hasGoAuth ? "Unable to fetch Go quota" : "No Go credentials configured"}
                  </text>
                  <text fg={muted}>Set OPENCODE_GO_API_KEY (or run opencode auth)</text>
                  <text fg={muted}>Legacy: OPENCODE_GO_AUTH_COOKIE + OPENCODE_GO_WORKSPACE_ID</text>
                </box>
              )}
            </>
          ) : null}
        </>
      ) : null}
    </box>
  )
}

export default UsageSidebar
