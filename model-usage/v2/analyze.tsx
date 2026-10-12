/** @jsxImportSource @opentui/solid */
/**
 * model-usage — v2 `/analyze` dialog.
 *
 * Port of the v1 analyze dialog onto the OpenCode 2.0.27 TUI plugin API. Host
 * interaction goes through the wlib `WlibHost` adapter and the v2 `Context`.
 *
 * ## Data source
 *
 * Session messages come from the v2 data API (`context.data.session.message.list`)
 * — reactive, host-projected, and current-session scoped — then mapped to the
 * legacy shape by `v2/message-adapter` so the pure `analyze-domain` layer is
 * unchanged. The server snapshot / persona-injector sidecar / baseline DB
 * readers are unchanged, preserving the system-snapshot contract.
 */

import type { Plugin } from "@opencode/plugin/tui"
import type { WlibHost } from "../wlib/src/host/types"
import { onMount, onCleanup, createSignal, createMemo, createEffect } from "solid-js"
import { log } from "../helpers/debug"
import { buildBar, fmt, truncateLabel, fmtCompact, fmtCost } from "../helpers/format"
import { writeClipboard } from "../wlib/src/core/clipboard"
import type { CompactionSummary } from "../helpers/compaction"
import { computeModelsTabLayout } from "../helpers/model-tab"
import type { ModelStat } from "../helpers/models"
import { calcCacheHitRate } from "../helpers/cost"
import { makeScrollState } from "../wlib/src/core/scroll"
import { registerDialogKeyLayer, type KeyBinding } from "../wlib/src/core/keys"
import { registerSlashCommand } from "../wlib/src/core/command"
import { createLoadGuard } from "../wlib/src/core/reload"
import { loadSystemSnapshot, loadBaselineTokens, loadFinalSystemOverride, analyzeSessionMessages, type AnalysisData, type CategoryEntry, type Category, type FormattedHotspotResult } from "../analyze-domain"
import { useDialogSizing } from "../wlib/src/ui/dialog"
import { buildHelpRows } from "../wlib/src/core/help"
import { HelpOverlay } from "../wlib/src/ui/help-overlay"
import { type Exportable } from "../wlib/src/core/export"
import { createExportController, type ExportController } from "../wlib/src/ui/export-controller"
import { CopiedFlash } from "../wlib/src/ui/copied-flash"
import { buildAnalyzeExport, buildAnalyzeExportData, ANALYZE_EXPORT_FORMATS } from "../helpers/export/analyze"
import { PLUGIN_NAME, PLUGIN_VERSION } from "../version"
import { toLegacyMessages } from "./message-adapter"

export function openAnalyze(context: Plugin.Context, host: WlibHost, sessionID: string) {
  if (!sessionID) {
    host.dialog.show(() => {
      const { fg, muted } = host.theme()
      return (
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <box flexDirection="row" gap={1}>
              <text fg={fg}><b>Analyze</b></text>
              <text fg={muted}>— No active session</text>
            </box>
            <text fg={muted}>esc</text>
          </box>
          <text fg={muted}>Open a session to analyze its token usage.</text>
        </box>
      )
    })
    host.dialog.set({ size: "medium" })
    return
  }

  // ── Derived values ───────────────────────────────────────────────
  const { fg, muted, red, primary, selectedText, panel } = host.theme()
  const BAR_WIDTH = 50
  const sidDisplay = sessionID.length > 8
    ? sessionID.slice(0, 8) + "…"
    : sessionID

  // ── State ─────────────────────────────────────────────────────────
  const [loading, setLoading] = createSignal(true)
  const [errorMsg, setErrorMsg] = createSignal("")
  const [categories, setCategories] = createSignal<Category[]>([])
  const [estimatedTotal, setEstimatedTotal] = createSignal<number>(0)
  const [topContributors, setTopContributors] = createSignal<CategoryEntry[]>([])
  const [hasToolsSection, setHasToolsSection] = createSignal(false)
  const [messageCount, setMessageCount] = createSignal<number>(0)
  const [activeTab, setActiveTab] = createSignal(0)
  const [showRaw, setShowRaw] = createSignal(false)
  const [rawSystemText, setRawSystemText] = createSignal("")
  const [rawToolDefsText, setRawToolDefsText] = createSignal("")
  const [modelStats, setModelStats] = createSignal<ModelStat[]>([])
  const [switchesCount, setSwitchesCount] = createSignal<number>(0)
  const [compactionSummary, setCompactionSummary] = createSignal<CompactionSummary | null>(null)
  const [sessionCost, setSessionCost] = createSignal<number>(0)
  const [hotspotResults, setHotspotResults] = createSignal<FormattedHotspotResult[]>([])
  const [expandedHotspotIndex, setExpandedHotspotIndex] = createSignal<number | null>(null)
  const [copiedFlash, setCopiedFlash] = createSignal<boolean>(false)
  const [toolDefsTokens, setToolDefsTokens] = createSignal<number>(0)
  const [syntheticTokens, setSyntheticTokens] = createSignal<number>(0)
  const [showHelp, setShowHelp] = createSignal(false)

  let pollInterval: any = null
  let cleanupKeyLayer: (() => void) | null = null
  let copiedTimeout: any = null
  const scroll = makeScrollState(createSignal)
  const loadGuard = createLoadGuard()

  // ── Tabs ─────────────────────────────────────────────────────────
  const tabs = createMemo(() => {
    const t: { id: string; label: string }[] = [{ id: "context", label: "Context" }]
    if (hasToolsSection()) t.push({ id: "tools", label: "Per-Tool" })
    const sysCat = categories().find((c: Category) => c.name.startsWith("SYSTEM"))
    if (sysCat && sysCat.entries.length >= 2) t.push({ id: "system", label: "System" })
    const tdCat = categories().find((c: Category) => c.name === "TOOL DEFS")
    if (tdCat && tdCat.entries.length >= 2) t.push({ id: "tooldefs", label: "Tool Defs" })
    if (modelStats().length > 0) t.push({ id: "models", label: "Models" })
    t.push({ id: "extra", label: "Extra Info" })
    return t
  })

  function switchTab(dir: number) {
    const list = tabs()
    if (list.length <= 1) return
    setActiveTab((t) => {
      const next = t + dir
      if (next < 0) return list.length - 1
      if (next >= list.length) return 0
      return next
    })
    scroll.scrollToTop()
    setShowRaw(false)
    setTimeout(() => scroll.checkOverflow(), 50)
  }

  // ── Export ────────────────────────────────────────────────────────
  const exportable: Exportable = {
    formats: ANALYZE_EXPORT_FORMATS,
    build: (format) => {
      if (loading()) return ""
      const analysis: AnalysisData = {
        categories: categories(),
        estimatedTotal: estimatedTotal(),
        topContributors: topContributors(),
        hasToolsSection: hasToolsSection(),
        messageCount: messageCount(),
        modelStats: modelStats(),
        switchesCount: switchesCount(),
        compactionSummary: compactionSummary(),
        sessionCost: sessionCost(),
        hotspotResults: hotspotResults(),
        rawSystemText: rawSystemText(),
        rawToolDefsText: rawToolDefsText(),
        toolDefsTokens: toolDefsTokens(),
        syntheticTokens: syntheticTokens(),
      }
      return buildAnalyzeExport(format, buildAnalyzeExportData(analysis, sessionID))
    },
  }
  let exporter: ExportController | null = null

  const analyzeBindings: KeyBinding[] = [
    { key: "left",     cmd: "analyze.tabLeft",     desc: "Previous tab" },
    { key: "right",    cmd: "analyze.tabRight",    desc: "Next tab" },
    { key: "up",       cmd: "analyze.scrollUp",    desc: "Scroll up" },
    { key: "down",     cmd: "analyze.scrollDown",  desc: "Scroll down" },
    { key: "pageup",   cmd: "analyze.pageUp",      desc: "Page up" },
    { key: "pagedown", cmd: "analyze.pageDown",    desc: "Page down" },
    { key: "v",        cmd: "analyze.toggleRaw",   desc: "Raw prompt" },
    { key: "c",        cmd: "analyze.copyRaw",     desc: "Copy raw prompt" },
    { key: "r",        cmd: "analyze.reload",      desc: "Reload" },
    { key: "1",        cmd: "analyze.expand1",     desc: "Expand message 1" },
    { key: "2",        cmd: "analyze.expand2",     desc: "Expand message 2" },
    { key: "3",        cmd: "analyze.expand3",     desc: "Expand message 3" },
    { key: "4",        cmd: "analyze.expand4",     desc: "Expand message 4" },
    { key: "5",        cmd: "analyze.expand5",     desc: "Expand message 5" },
    { key: "e",        cmd: "analyze.export",      desc: "Export" },
    { key: "h",        cmd: "analyze.help",        desc: "Help" },
    { key: "escape",   cmd: "analyze.escape",      desc: "Close" },
  ]

  // ── Data loader ───────────────────────────────────────────────────
  function loadAnalysis() {
    const gen = loadGuard.invalidate()
    try {
      // v2 data API: reactive, host-projected session messages.
      const rawMessages = context.data.session.message.list(sessionID) ?? []
      const messages = toLegacyMessages(rawMessages)
      if (!loadGuard.isCurrent(gen)) { log("analyze: stale fetch, discarding"); return }
      setMessageCount(messages.length)
      log("=== analyze(v2): loaded", messages.length, "messages for session", sessionID, "===")

      if (messages.length === 0) {
        setLoading(false)
        return
      }

      const serverSnapshot = loadSystemSnapshot(sessionID)
      const baselineTokens = loadBaselineTokens(sessionID)
      const finalSystemOverride = loadFinalSystemOverride(sessionID)

      const data = analyzeSessionMessages(messages, sessionID, serverSnapshot, baselineTokens, finalSystemOverride)

      setRawSystemText(data.rawSystemText)
      setRawToolDefsText(data.rawToolDefsText)
      setCategories(data.categories)
      setEstimatedTotal(data.estimatedTotal)
      setTopContributors(data.topContributors)
      setHasToolsSection(data.hasToolsSection)
      setModelStats(data.modelStats)
      setSwitchesCount(data.switchesCount)
      setCompactionSummary(data.compactionSummary)
      setSessionCost(data.sessionCost)
      setHotspotResults(data.hotspotResults)
      setToolDefsTokens(data.toolDefsTokens)
      setSyntheticTokens(data.syntheticTokens)

      setLoading(false)
      setTimeout(() => scroll.checkOverflow(), 50)
    } catch (err) {
      setErrorMsg(String(err))
      setLoading(false)
    }
  }

  function reload() {
    log("analyze: reload triggered")
    loadGuard.invalidate()
    setShowRaw(false)
    setRawSystemText("")
    setRawToolDefsText("")
    setToolDefsTokens(0)
    setSyntheticTokens(0)
    setLoading(true)
    loadAnalysis()
  }

  const AUTO_POLL_MS = 60_000
  function backgroundReload() {
    log("analyze: background reload")
    loadGuard.invalidate()
    loadAnalysis()
  }

  // ── Reactive dialog ──────────────────────────────────────────────
  host.dialog.show(() => {
    const dialogSizing = useDialogSizing(host, { size: "large", maxHeight: 40 })
    const geom = host.renderer.read()
    log(
      "[mu:analyze] dialog open",
      `renderer kind=${host.kind}`,
      `geometry w=${geom.width} h=${geom.height}`,
      `stdout w=${process.stdout.columns} h=${process.stdout.rows}`,
    )
    createEffect(() => {
      const fit = dialogSizing()
      host.dialog.set({ size: fit.size })
      log("[mu:analyze] sizing", fit.size, fit.maxHeight)
    })

    const toggleExpand = (idx: number) => {
      const list = tabs()
      const currentTab = list[Math.min(activeTab(), list.length - 1)]
      if (currentTab?.id !== "extra") return
      if (idx >= hotspotResults().length) return
      setExpandedHotspotIndex((prev) => (prev === idx ? null : idx))
    }

    const copyActiveRawText = async () => {
      const list = tabs()
      const currentTab = list[Math.min(activeTab(), list.length - 1)]
      if (!showRaw()) return
      const text = currentTab?.id === "system"
        ? rawSystemText()
        : currentTab?.id === "tooldefs"
          ? rawToolDefsText()
          : ""
      if (!text) return
      const success = await writeClipboard(text)
      if (success) {
        if (copiedTimeout) clearTimeout(copiedTimeout)
        setCopiedFlash(true)
        copiedTimeout = setTimeout(() => {
          setCopiedFlash(false)
          copiedTimeout = null
        }, 2000)
      }
    }

    exporter = createExportController(host, exportable, { name: "analyze" })

    function handleKey(key: string) {
      if (exporter?.handleKey(key)) return true
      if (showHelp()) {
        if (key === "h" || key === "escape") {
          setShowHelp(false)
        }
        return true
      }
      if (key === "e") {
        exporter?.open()
        return true
      }
      if (key === "h") {
        setShowHelp((v) => !v)
        return true
      }
      if (key === "escape") {
        host.dialog.clear()
        return true
      }
      if (key === "left") {
        switchTab(-1)
        return true
      }
      if (key === "right") {
        switchTab(1)
        return true
      }
      if (key === "v") {
        const list = tabs()
        const idx = Math.min(activeTab(), list.length - 1)
        const id = list[idx]?.id
        if (id === "system" || id === "tooldefs") setShowRaw((s) => !s)
        return true
      }
      if (key === "c") {
        void copyActiveRawText()
        return true
      }
      if (key === "r") {
        reload()
        return true
      }
      if (key === "1") { toggleExpand(0); return true }
      if (key === "2") { toggleExpand(1); return true }
      if (key === "3") { toggleExpand(2); return true }
      if (key === "4") { toggleExpand(3); return true }
      if (key === "5") { toggleExpand(4); return true }
      if (key === "up") {
        return scroll.handleUp()
      }
      if (key === "down") {
        return scroll.handleDown()
      }
      if (key === "pageup")   { scroll.handlePageUp(); return true }
      if (key === "pagedown") { scroll.handlePageDown(); return true }
      return false
    }

    onMount(() => {
      cleanupKeyLayer = registerDialogKeyLayer(host, {
        priority: 1,
        bindings: analyzeBindings,
        commands: [
          { name: "analyze.tabLeft",    title: "Previous Tab",     run: async () => { handleKey("left") } },
          { name: "analyze.tabRight",   title: "Next Tab",         run: async () => { handleKey("right") } },
          { name: "analyze.scrollUp",   title: "Scroll Up",        run: async () => { handleKey("up") } },
          { name: "analyze.scrollDown", title: "Scroll Down",      run: async () => { handleKey("down") } },
          { name: "analyze.pageUp",     title: "Page Up",          run: async () => { handleKey("pageup") } },
          { name: "analyze.pageDown",   title: "Page Down",        run: async () => { handleKey("pagedown") } },
          { name: "analyze.toggleRaw",  title: "Raw Prompt",       run: async () => { handleKey("v") } },
          { name: "analyze.copyRaw",    title: "Copy Raw Prompt",  run: async () => { handleKey("c") } },
          { name: "analyze.reload",     title: "Reload",           run: async () => { handleKey("r") } },
          { name: "analyze.expand1",    title: "Toggle Expand Message 1", run: () => { handleKey("1") } },
          { name: "analyze.expand2",    title: "Toggle Expand Message 2", run: () => { handleKey("2") } },
          { name: "analyze.expand3",    title: "Toggle Expand Message 3", run: () => { handleKey("3") } },
          { name: "analyze.expand4",    title: "Toggle Expand Message 4", run: () => { handleKey("4") } },
          { name: "analyze.expand5",    title: "Toggle Expand Message 5", run: () => { handleKey("5") } },
          { name: "analyze.export",     title: "Export",           run: async () => { handleKey("e") } },
          { name: "analyze.help",       title: "Toggle Help",      run: async () => { handleKey("h") } },
          { name: "analyze.escape",     title: "Close",            run: async () => { handleKey("escape") } },
        ],
      })

      loadAnalysis()

      pollInterval = setInterval(() => {
        backgroundReload()
      }, AUTO_POLL_MS)
    })

    onCleanup(() => {
      if (cleanupKeyLayer) {
        try { cleanupKeyLayer() } catch { /* ignore */ }
        cleanupKeyLayer = null
      }
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
      if (copiedTimeout) {
        clearTimeout(copiedTimeout)
        copiedTimeout = null
      }
    })

    const safeFmt = (n: number) => (n > 0 ? fmt(n) : "0")

    return (
      <>
      <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <box flexDirection="row" gap={1}>
            <text fg={fg}><b>Analyze</b></text>
            <text fg={muted}>— Session {sidDisplay}</text>
          </box>
          <text fg={muted}>esc</text>
        </box>

        {(() => {
          const list = tabs()
          if (list.length <= 1) return <text fg={muted}> </text>
          const idx = Math.min(activeTab(), list.length - 1)
          return (
            <box flexDirection="row" gap={1}>
              {list.map((tab, i) => (
                <box
                  key={tab.id}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={i === idx ? primary : undefined}
                >
                  <text fg={i === idx ? selectedText : muted}>{tab.label}</text>
                </box>
              ))}
            </box>
          )
        })()}

        <text fg={muted}>{scroll.hasOverflow() && scroll.isScrolled() ? "▲ more above" : " "}</text>

        <scrollbox
          ref={(el) => scroll.scrollRef = el}
          maxHeight={dialogSizing().maxHeight}
          scrollbarOptions={{ visible: false }}
        >
          {loading() && categories().length === 0 ? (
            <text fg={muted}>Loading session messages…</text>
          ) : errorMsg() ? (
            <box flexDirection="column" gap={1}>
              <text fg={red}><b>Error Fetching Messages</b></text>
              <text fg={muted}>{errorMsg()}</text>
            </box>
          ) : categories().length === 0 ? (
            <text fg={muted}>No messages in this session.</text>
          ) : (
            (() => {
              const list = tabs()
              const idx = Math.min(activeTab(), list.length - 1)
              const tab = list[idx]
              if (!tab) return <text fg={muted}>No data.</text>

              if (tab.id === "context") {
                return (
                  <box paddingBottom={1}>
                    <text fg={fg}><b>Context Breakdown</b></text>
                    <text> </text>
                    <box flexDirection="column" gap={1}>
                      {categories().map((cat) => {
                        const total = estimatedTotal()
                        const pct = total > 0 ? (cat.totalTokens / total) * 100 : 0
                        const bar = buildBar(pct, BAR_WIDTH)
                        return (
                          <box key={cat.name} flexDirection="column" gap={1}>
                            <text fg={fg}><b>{cat.name}</b></text>
                            <text fg={muted}>{pct.toFixed(1)}% — {safeFmt(cat.totalTokens)} tokens</text>
                            <text fg={fg}>{bar}</text>
                          </box>
                        )
                      })}
                    </box>
                    <text> </text>
                    <text fg={fg}>
                      Total: {safeFmt(estimatedTotal())} tokens ({safeFmt(messageCount())} msgs)
                    </text>
                  </box>
                )
              }

              if (tab.id === "tools") {
                const toolsCat = categories().find((c: Category) => c.name === "TOOLS")
                if (!toolsCat || toolsCat.entries.length === 0) {
                  return <text fg={muted}>No tool data.</text>
                }
                const total = estimatedTotal()
                return (
                  <box paddingBottom={1}>
                    <text fg={fg}><b>Per-Tool Breakdown</b></text>
                    <text> </text>
                    <box flexDirection="column" gap={1}>
                      {toolsCat.entries.map((entry: CategoryEntry) => {
                        const pct = total > 0 ? (entry.tokens / total) * 100 : 0
                        const bar = buildBar(pct, BAR_WIDTH)
                        return (
                          <box key={entry.label} flexDirection="column" gap={1}>
                            <text fg={fg}>{entry.label}</text>
                            <text fg={muted}>{safeFmt(entry.tokens)} tokens</text>
                            <text fg={fg}>{bar}</text>
                          </box>
                        )
                      })}
                    </box>
                  </box>
                )
              }

              if (tab.id === "system") {
                const sysCat = categories().find((c: Category) => c.name.startsWith("SYSTEM"))
                if (!sysCat || sysCat.entries.length < 2) {
                  return <text fg={muted}>No system breakdown data.</text>
                }
                const sysTotal = sysCat.totalTokens

                if (showRaw()) {
                  const raw = rawSystemText()
                  return (
                    <box paddingBottom={1}>
                      <text fg={fg}><b>Raw System Prompt</b> ({safeFmt(sysTotal)} tokens)</text>
                      {sysCat.name.includes("server") && <text fg={muted}>⚠ Server-estimated tokens</text>}
                      <text> </text>
                      {raw
                        ? <text fg={fg}>{raw.length > 50000 ? raw.slice(0, 50000) + "\n\n… (truncated at 50000 chars)" : raw}</text>
                        : <text fg={muted}>No raw text stored for this session.</text>
                      }
                    </box>
                  )
                }

                const sorted = [...sysCat.entries].sort((a: CategoryEntry, b: CategoryEntry) => b.tokens - a.tokens)
                return (
                  <box paddingBottom={1}>
                    <text fg={fg}><b>System Breakdown</b> ({safeFmt(sysTotal)} tokens)</text>
                    {sysCat.name.includes("server") && <text fg={muted}>⚠ Server-estimated tokens</text>}
                    <text> </text>
                    <box flexDirection="column" gap={1}>
                      {sorted.map((entry: CategoryEntry, i: number) => {
                        const pct = sysTotal > 0 ? (entry.tokens / sysTotal) * 100 : 0
                        const bar = buildBar(pct, BAR_WIDTH)
                        return (
                          <box key={entry.label + i} flexDirection="column" gap={1}>
                            <text fg={fg}>{entry.label}</text>
                            <text fg={muted}>{safeFmt(entry.tokens)} tokens ({pct.toFixed(1)}%)</text>
                            <text fg={fg}>{bar}</text>
                          </box>
                        )
                      })}
                    </box>
                  </box>
                )
              }

              if (tab.id === "tooldefs") {
                const tdCat = categories().find((c: Category) => c.name === "TOOL DEFS")
                if (!tdCat || tdCat.entries.length < 2) {
                  return <text fg={muted}>No tool definition breakdown data.</text>
                }
                const tdTotal = tdCat.totalTokens

                if (showRaw()) {
                  const raw = rawToolDefsText()
                  return (
                    <box paddingBottom={1}>
                      <text fg={fg}><b>Raw Tool Definitions</b> ({safeFmt(tdTotal)} tokens)</text>
                      <text fg={muted}>⚠ Server-estimated tokens</text>
                      <text> </text>
                      {raw
                        ? <text fg={fg}>{raw.length > 50000 ? raw.slice(0, 50000) + "\n\n… (truncated at 50000 chars)" : raw}</text>
                        : <text fg={muted}>No raw text stored for this session.</text>}
                    </box>
                  )
                }

                const sorted = [...tdCat.entries].sort((a: CategoryEntry, b: CategoryEntry) => b.tokens - a.tokens)
                return (
                  <box paddingBottom={1}>
                    <text fg={fg}><b>Tool Definitions</b> ({safeFmt(tdTotal)} tokens)</text>
                    <text fg={muted}>⚠ Server-estimated tokens</text>
                    <text> </text>
                    <box flexDirection="column" gap={1}>
                      {sorted.map((entry: CategoryEntry, i: number) => {
                        const pct = tdTotal > 0 ? (entry.tokens / tdTotal) * 100 : 0
                        const bar = buildBar(pct, BAR_WIDTH)
                        return (
                          <box key={entry.label + i} flexDirection="column" gap={1}>
                            <text fg={fg}>{entry.label}</text>
                            <text fg={muted}>{safeFmt(entry.tokens)} tokens ({pct.toFixed(1)}%)</text>
                            <text fg={fg}>{bar}</text>
                          </box>
                        )
                      })}
                    </box>
                  </box>
                )
              }

              if (tab.id === "models") {
                const stats = modelStats()
                if (stats.length === 0) {
                  return <text fg={muted}>No model usage data.</text>
                }

                const { sortedStats, totalModelTokens } = computeModelsTabLayout(stats)

                return (
                  <box paddingBottom={1}>
                    <text fg={fg}><b>Models in Session</b></text>
                    <text> </text>
                    <box flexDirection="column" gap={1}>
                      {sortedStats.map((m, i) => {
                        const modelTokens = m.peakInputTokens + m.outputTokens
                        const pct = totalModelTokens > 0 ? (modelTokens / totalModelTokens) * 100 : 0
                        const hitRate = calcCacheHitRate(m.cacheRead, m.inputTokens)

                        const parts = [
                          `↑ ${fmt(m.peakInputTokens)}`,
                          `↓ ${fmt(m.outputTokens)}`
                        ]
                        if (hitRate !== null) {
                          parts.push(`cache ${hitRate}% (${fmt(m.cacheRead)} read, ${fmt(m.cacheWrite)} write)`)
                        }
                        parts.push(`${pct.toFixed(1)}% tokens`)
                        if (m.cost > 0) {
                          parts.push(fmtCost(m.cost))
                        }
                        const infoLine = parts.join("  ")

                        return (
                          <box key={m.providerID + "/" + m.modelID} flexDirection="column" gap={1}>
                            <text fg={fg}>{i + 1}. {m.providerID} / {m.modelID}  ·  {m.msgCount} msgs</text>
                            <text fg={muted}>{infoLine}</text>
                            <text fg={fg}>{buildBar(pct, 50)}</text>
                          </box>
                        )
                      })}
                    </box>
                  </box>
                )
              }

              if (tab.id === "extra") {
                const top = topContributors()
                const cost = sessionCost()
                const comp = compactionSummary()
                const stats = modelStats()
                const hotspots = hotspotResults()

                return (
                  <box paddingBottom={1} flexDirection="column" gap={1}>
                    <box flexDirection="column" gap={0}>
                      <text fg={fg}><b>Top Contributors</b></text>
                      <text> </text>
                      {top.length === 0 ? (
                        <text fg={muted}>No contributor data.</text>
                      ) : (
                        <box flexDirection="column" gap={0}>
                          {top.map((entry, i) => (
                            <text key={entry.label + i} fg={fg}>
                              {String(i + 1).padStart(2)}. {truncateLabel(entry.label)}{safeFmt(entry.tokens).padStart(10)} tokens
                            </text>
                          ))}
                        </box>
                      )}
                    </box>

                    {cost > 0 && (
                      <box flexDirection="column" gap={0}>
                        <text> </text>
                        <text fg={fg}><b>Session cost</b>: {fmtCost(cost)}</text>
                      </box>
                    )}

                    {(() => {
                      if (!comp || comp.count === 0) return null
                      const reductionText = comp.reductionTokens > 0 ? `, -${fmtCompact(comp.reductionTokens)} tokens` : ""
                      const pendingCount = comp.count - comp.measured
                      const pendingText = pendingCount > 0 && pendingCount < comp.count ? ` (${pendingCount} pending)` : ""
                      return (
                        <box flexDirection="column" gap={0}>
                          <text> </text>
                          <text fg={fg}>
                            <b>Compactions</b>: {comp.count}{reductionText}{pendingText}
                          </text>
                        </box>
                      )
                    })()}

                    {(() => {
                      if (stats.length === 0) return null
                      if (stats.length === 1) {
                        return (
                          <box flexDirection="column" gap={0}>
                            <text> </text>
                            <text fg={fg}><b>Model</b>: {stats[0].modelID}</text>
                          </box>
                        )
                      }
                      const sortedStats = [...stats].sort((a, b) => b.msgCount - a.msgCount)
                      return (
                        <box flexDirection="column" gap={0}>
                          <text> </text>
                          <text fg={fg}><b>Model switches: {switchesCount()}</b></text>
                          <text> </text>
                          {sortedStats.map((st) => (
                            <text key={st.providerID + "/" + st.modelID} fg={muted}>
                              {"  "}{st.providerID} / {st.modelID}        {st.msgCount} msgs
                            </text>
                          ))}
                        </box>
                      )
                    })()}

                    {hotspots.length > 0 && (
                      <box flexDirection="column" gap={0}>
                        <text> </text>
                        <text fg={fg}><b>Unusually large messages: {hotspots.length}</b></text>
                        <text> </text>
                        {hotspots.map((res, idx) => {
                          const isExpanded = expandedHotspotIndex() === idx
                          return (
                            <box key={res.category + "/" + res.label + "/" + idx} flexDirection="column" gap={0} onMouseUp={() => toggleExpand(idx)}>
                              <text fg={fg}>
                                {"  "}{isExpanded ? "▾" : "▸"} {res.label}  {fmt(res.tokens)} tok  ({res.formattedRatio}x avg)
                              </text>
                              {!isExpanded && (
                                <text fg={muted}>
                                  {"    "}{res.preview}
                                </text>
                              )}
                              {isExpanded && (
                                <box paddingLeft={4} paddingTop={1} paddingBottom={1} flexDirection="column">
                                  <box borderStyle="round" borderColor={muted} padding={1}>
                                    <text fg={fg}>{res.fullText}</text>
                                  </box>
                                </box>
                              )}
                            </box>
                          )
                        })}
                      </box>
                    )}
                  </box>
                )
              }

              return <text fg={muted}>Unknown tab.</text>
            })()
          )}
        </scrollbox>

        <text fg={muted}>{scroll.hasOverflow() && !scroll.isAtBottom() ? "▼ more below" : " "}</text>

        {(() => {
          const list = tabs()
          const idx = Math.min(activeTab(), list.length - 1)
          const currentTab = list[idx]
          const isSys = currentTab?.id === "system"
          const isToolDefs = currentTab?.id === "tooldefs"
          const isExtra = currentTab?.id === "extra"
          const hasHotspots = hotspotResults().length > 0

          return (
            <box flexDirection="row" gap={1}>
              <text fg={muted}>← → tabs  ·  ↑↓ scroll</text>
              {(isSys || isToolDefs) && (
                <>
                  <text fg={muted}>·  v raw</text>
                  {showRaw() && (
                    <>
                      <text fg={muted}>·</text>
                      <CopiedFlash copied={copiedFlash()} hint="c copy" muted={muted} primary={primary} />
                    </>
                  )}
                </>
              )}
              {isExtra && hasHotspots && (
                <text fg={muted}>·  1-5 expand</text>
              )}
              <text fg={muted}>·  r reload</text>
              <text fg={muted}>·</text>
              <CopiedFlash copied={exporter!.copiedFlash()} hint="e export" muted={muted} primary={primary} />
              <text fg={muted}>·  h help</text>
            </box>
          )
        })()}
      </box>
      {showHelp() && (
        <HelpOverlay rows={buildHelpRows(analyzeBindings)} fg={fg} muted={muted} bg={panel} title="Analyze Shortcuts" name={PLUGIN_NAME} version={PLUGIN_VERSION} />
      )}
      {exporter!.renderOverlay()}
      {exporter!.renderResultOverlay()}
      </>
    )
  })
}

export function registerAnalyzeCommand(context: Plugin.Context, host: WlibHost) {
  registerSlashCommand(host, {
    name: "analyze.show",
    title: "Analyze Session Tokens",
    slashName: "analyze",
    key: { key: "ctrl+shift+a", desc: "Analyze Session Tokens" },
    async run() {
      // Resolve the current session ID from the v2 router, then open the dialog.
      const route = context.ui.router.current()
      const resolvedSessionID = route.type === "session" ? route.sessionID : undefined
      openAnalyze(context, host, resolvedSessionID ?? "")
    },
  })
}
