/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"

import { onMount, onCleanup, createSignal, createEffect, createMemo } from "solid-js"
import { getMonthInfo, isCurrentMonth, getWeekMonday, getWeekInfo, computeMinOffsets, getDaysInMonth, getDayOfMonth } from "./helpers/dates"
import { resolveProjection } from "./helpers/projection"
import { log } from "./helpers/debug"
import { fmt, fmtCost, fmtCostPerMillion, buildBar, fmtCompact, formatPercentDiff } from "./helpers/format"
import type { UsageData, ModelUsage } from "./types"
import { getEarliestUsageDate, fetchRawRows, queryUsage, queryDailyTotals, ensureMessageTimeIndex, fetchRootSessionTimestamps, queryTopSessions, type PeriodStats, type TopSession } from "./db"
import { openAnalyze } from "./analyze"
import { sortModels, costPerMillion, type ModelSortKey } from "./helpers/models"
import { makeScrollState } from "./wlib/scroll"
import { registerDialogKeyLayer, type KeyBinding } from "./wlib/keys"
import { buildHelpRows } from "./wlib/help"
import { HelpOverlay } from "./wlib/help-overlay"
import { EXPORT_FORMATS, type Exportable } from "./wlib/export"
import { createExportController, type ExportController } from "./wlib/export-controller"
import { CopiedFlash } from "./wlib/copied-flash"
import { buildExport, buildExportData, type ExportPeriod } from "./helpers/export/usage"
import { useDialogSizing } from "./wlib/dialog"
import { resolveThemeColors } from "./wlib/theme"
import { toggleSessionSort, clampScrollTop } from "./helpers/session-sort"

import { MS_PER_DAY, CACHE_TTL_MS, PREFETCH_DELAY_MS, type CachePeriod, getMonthCache, flushDiskSave, updateMonthCache, getCachedEarliestTs, setCachedEarliestTs, getCachedMonths, findNullCountMonths } from "./cache"
import { type Granularity, buildHierarchy, findPreviousPeriodTotal, computeTrendSeries } from "./usage-domain"
import { PLUGIN_NAME, PLUGIN_VERSION } from "./version"

export function registerUsageCommand(api: TuiPluginApi) {
  api.keymap.registerLayer({
    commands: [
      {
        name: "usage.show",
        title: "Show Monthly Usage",
        category: "Plugin",
        namespace: "palette",
        slashName: "usage",
        async run() {
          const dbPath = `${homedir()}/.local/share/opencode/opencode.db`
          const now = new Date()

          const { fg, muted, red, panel, primary } = resolveThemeColors(api.theme.current)

          if (!existsSync(dbPath)) {
            api.ui.dialog.replace(() => {
              onMount(() => { api.ui.dialog.setSize("medium") })
              return (
                <box padding={2} flexDirection="column" gap={1}>
                  <text fg={red}><b>Usage Data Unavailable</b></text>
                  <text fg={muted}>Database not found at the expected location.</text>
                  <text fg={muted}>Please try again later.</text>
                </box>
              )
            })
            return
          }

          let db: Database | null = null
          let cleanedUp = false
          try {
            db = new Database(dbPath, { readonly: true })
          } catch (err) {
            api.ui.dialog.replace(() => {
              onMount(() => { api.ui.dialog.setSize("medium") })
              return (
                <box padding={2} flexDirection="column" gap={1}>
                  <text fg={red}><b>Usage Data Unavailable</b></text>
                  <text fg={muted}>Could not open database.</text>
                  <text fg={muted}>{err instanceof Error ? err.message : String(err)}</text>
                </box>
              )
            })
            return
          }

          const cachedEarliest = getCachedEarliestTs()
          const initOffsets = computeMinOffsets(cachedEarliest, now)
          const [minMonthOffset, setMinMonthOffset] = createSignal(initOffsets.minMonthOffset)
          const [minWeekOffset, setMinWeekOffset] = createSignal(initOffsets.minWeekOffset)
          const [minDayOffset, setMinDayOffset] = createSignal(initOffsets.minDayOffset)

          const [granularity, setGranularity] = createSignal<Granularity>("month")
          const [monthOffset, setMonthOffset] = createSignal(0)
          const [weekOffset, setWeekOffset] = createSignal(0)
          const [dayOffset, setDayOffset] = createSignal(0)
          const [sortKey, setSortKey] = createSignal<ModelSortKey>("tokens")
          const [periodStats, setPeriodStats] = createSignal<PeriodStats | null>(null)
          const [showTrends, setShowTrends] = createSignal(false)
          const [showHelp, setShowHelp] = createSignal(false)
          const [sessionView, setSessionView] = createSignal(false)
          const [topSessions, setTopSessions] = createSignal<TopSession[]>([])
          const [selectedSessionIdx, setSelectedSessionIdx] = createSignal(0)
          const fetchDailyTotals = (s: number, e: number) => {
            if (!db) return []
            const r = queryDailyTotals(db, s, e)
            return "error" in r ? [] : r
          }
          const computeTrends = () => computeTrendSeries(granularity(), Date.now(), getMonthCache, fetchDailyTotals)
          const trendSeries = createMemo(() => {
            if (!showTrends()) return null
            return computeTrends()
          })
          const scroll = makeScrollState(createSignal)

          const scrollSessionIntoView = () => {
            const el = scroll.scrollRef
            if (!el) return
            const row = el.querySelector(`[data-session-idx="${selectedSessionIdx()}"]`) as HTMLElement | null
            if (!row) return
            const viewH = el.clientHeight || el.height || 0
            const scrollH = el.scrollHeight || el.height || 0
            const top = row.offsetTop
            const bottom = top + row.offsetHeight
            let scrollTop = el.scrollTop
            if (top < scrollTop) scrollTop = top
            else if (bottom > scrollTop + viewH) scrollTop = bottom - viewH
            el.scrollTop = clampScrollTop(scrollTop, scrollH, viewH)
          }

          const computeWindow = () => {
            if (granularity() === "month") {
              const m = now.getUTCMonth() + monthOffset()
              const y = now.getUTCFullYear() + Math.floor(m / 12)
              const month = ((m % 12) + 12) % 12
              const { startMs, endMs, label } = getMonthInfo(y, month)
              return { startMs, endMs, label }
            } else if (granularity() === "week") {
              const currentMonday = getWeekMonday(now)
              const targetMonday = new Date(currentMonday.getTime() + weekOffset() * 7 * MS_PER_DAY)
              const { startMs, endMs, label } = getWeekInfo(targetMonday)
              return { startMs, endMs, label }
            } else {
              const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
              const targetDayMs = currentDayStart + dayOffset() * MS_PER_DAY
              const startMs = targetDayMs
              const endMs = startMs + MS_PER_DAY
              const d = new Date(startMs)
              const label = d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
              return { startMs, endMs, label }
            }
          }

          const [viewState, setViewState] = createSignal<"loading" | "error" | UsageData>("loading")
          const [errorMsg, setErrorMsg] = createSignal<string>("")
          const [hasLoadedOnce, setHasLoadedOnce] = createSignal(false)
          const [diffInfo, setDiffInfo] = createSignal<{ arrow: string; text: string }>({ arrow: "\u2014", text: "\u2014" })

          const modelCache = new Map<string, UsageData>()
          const buildingMonths = new Set<number>()

          function modelCacheKey(gran: Granularity, startMs: number): string {
            return `${gran}:${startMs}`
          }

          function computeAndSetDiff(startMs: number, currentTotal: number) {
            const prev = findPreviousPeriodTotal(startMs, granularity(), getMonthCache)
            setDiffInfo(formatPercentDiff(currentTotal, prev))
          }

          function resolvePeriodStats(startMs: number, gran: Granularity): PeriodStats | null {
            if (gran === "month") {
              const mc = getMonthCache(startMs)
              if (mc && mc.sessionCount != null && mc.messageCount != null) {
                return { sessions: mc.sessionCount, messages: mc.messageCount }
              }
            } else {
              const monthStart = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1)
              const mc = getMonthCache(monthStart)
              const list = gran === "week" ? mc?.weeks : mc?.days
              const cached = list?.find(p => p.startMs === startMs)
              if (cached && cached.sessionCount != null && cached.messageCount != null) {
                return { sessions: cached.sessionCount, messages: cached.messageCount }
              }
            }
            return null
          }

          // ── Shared background pipeline (hierarchy build + forward prefetch) ──
          function buildAndCacheMonth(monthStart: number, monthEnd: number): boolean {
            if (!db) return false
            const rowsResult = fetchRawRows(db, monthStart, monthEnd)
            if ("error" in rowsResult) return false
            const sessResult = fetchRootSessionTimestamps(db, monthStart, monthEnd)
            const sessionTimes = "error" in sessResult ? [] : sessResult
            const period = buildHierarchy(rowsResult, sessionTimes, monthStart, monthEnd)
            updateMonthCache(period)
            return true
          }

          function scheduleHierarchyBuild(startMs: number, endMs: number, gran: Granularity) {
            const d = new Date(startMs)
            const monthStart = gran === "month" ? startMs : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
            const monthEnd = gran === "month" ? endMs : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
            if (buildingMonths.has(monthStart)) return
            buildingMonths.add(monthStart)
            setTimeout(() => {
              if (cleanedUp || !db) {
                buildingMonths.delete(monthStart)
                return
              }
              try {
                if (buildAndCacheMonth(monthStart, monthEnd)) {
                  const current = computeWindow()
                  setPeriodStats(resolvePeriodStats(current.startMs, granularity()))
                }
              } finally {
                buildingMonths.delete(monthStart)
              }
            }, 0)
          }

          function backfillNullCounts() {
            if (!db) return
            for (const month of findNullCountMonths(getCachedMonths())) {
              scheduleHierarchyBuild(month.startMs, month.endMs, "month")
            }
          }

          function schedulePrefetch(startMs: number, endMs: number) {
            setTimeout(() => {
              if (cleanedUp || !db) return
              const nextGran = granularity()
              if (nextGran === "month") {
                const d = new Date(startMs)
                const nextStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
                const nextKey = modelCacheKey("month", nextStart)
                if (!modelCache.has(nextKey)) {
                  const nextEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 1)
                  const adjResult = queryUsage(db, nextStart, nextEnd)
                  if (!("error" in adjResult)) {
                    modelCache.set(nextKey, adjResult)
                  }
                }
              } else {
                const periodMs = nextGran === "week" ? 7 * MS_PER_DAY : MS_PER_DAY
                const nextStart = startMs + periodMs
                const nextKey = modelCacheKey(nextGran, nextStart)
                if (!modelCache.has(nextKey)) {
                  const adjResult = queryUsage(db, nextStart, nextStart + periodMs)
                  if (!("error" in adjResult)) {
                    modelCache.set(nextKey, adjResult)
                  }
                }
              }
            }, PREFETCH_DELAY_MS)
          }

          // Step 1 query + shared Step 2/3. `background` suppresses error rendering so a
          // stale-but-shown frame is never replaced by an error screen during refresh.
          function runQueryPipeline(startMs: number, endMs: number, gran: Granularity, background: boolean = false) {
            if (!db) return
            const usageResult = queryUsage(db, startMs, endMs)
            if ("error" in usageResult) {
              if (!background) {
                setErrorMsg(usageResult.error)
                setViewState("error")
                if (!hasLoadedOnce()) setHasLoadedOnce(true)
              }
              return
            }
            const usageData = usageResult
            modelCache.set(modelCacheKey(gran, startMs), usageData)
            setViewState(usageData)
            computeAndSetDiff(startMs, usageData.totalInput + usageData.totalOutput)
            if (!hasLoadedOnce()) setHasLoadedOnce(true)

            scheduleHierarchyBuild(startMs, endMs, gran)
            schedulePrefetch(startMs, endMs)
          }

          function refreshInBackground(startMs: number, endMs: number, gran: Granularity) {
            setTimeout(() => {
              if (cleanedUp || !db) return
              runQueryPipeline(startMs, endMs, gran, true)
            }, 0)
          }

          function loadData(forceRefresh: boolean = false) {
            const { startMs, endMs } = computeWindow()
            const gran = granularity()
            loadSessionData()
            const cachedStats = resolvePeriodStats(startMs, gran)
            setPeriodStats(cachedStats)
            const cacheKey = modelCacheKey(gran, startMs)

            if (!forceRefresh) {
              const cachedModelData = modelCache.get(cacheKey)
              if (cachedModelData) {
                setViewState(cachedModelData)
                const currentTotal = cachedModelData.totalInput + cachedModelData.totalOutput
                computeAndSetDiff(startMs, currentTotal)
                if (!hasLoadedOnce()) setHasLoadedOnce(true)
                return
              }
            }

            if (!forceRefresh && gran === "month") {
              const fileCached = getMonthCache(startMs)
              if (fileCached) {
                const models = fileCached.models ?? []
                const isCurrent = isCurrentMonth(startMs)
                const isStale = isCurrent && (Date.now() - fileCached.lastUpdated) >= CACHE_TTL_MS
                const data: UsageData = {
                  models,
                  totalInput: fileCached.inputTokens,
                  totalOutput: fileCached.outputTokens,
                  totalCost: fileCached.totalCost,
                }
                setViewState(data)
                modelCache.set(cacheKey, data)

                const currentTotal = fileCached.inputTokens + fileCached.outputTokens
                computeAndSetDiff(startMs, currentTotal)

                if (!hasLoadedOnce()) setHasLoadedOnce(true)
                if (isStale) refreshInBackground(startMs, endMs, gran)
                return
              }
            } else if (!forceRefresh && (gran === "week" || gran === "day")) {
              const monthStart = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1)
              const monthCached = getMonthCache(monthStart)
              const periodList = gran === "week" ? monthCached?.weeks : monthCached?.days
              const period = periodList?.find(p => p.startMs === startMs)
              if (period) {
                const models = period.models ?? []
                const isCurrent = gran === "week" ? weekOffset() === 0 : dayOffset() === 0
                const isStale = isCurrent && (Date.now() - period.lastUpdated) >= CACHE_TTL_MS
                const data: UsageData = {
                  models,
                  totalInput: period.inputTokens,
                  totalOutput: period.outputTokens,
                  totalCost: period.totalCost,
                }
                setViewState(data)
                modelCache.set(cacheKey, data)

                const currentTotal = period.inputTokens + period.outputTokens
                computeAndSetDiff(startMs, currentTotal)

                // Prefill adjacent model cache from hierarchy (sync, no DB)
                const periodMs = gran === "week" ? 7 * MS_PER_DAY : MS_PER_DAY
                const nextStart = startMs + periodMs
                const nextKey = modelCacheKey(gran, nextStart)
                if (!modelCache.has(nextKey)) {
                  let adjPeriod: CachePeriod | undefined
                  adjPeriod = periodList?.find(p => p.startMs === nextStart)
                  if (!adjPeriod) {
                    const adjMonthStart = Date.UTC(new Date(nextStart).getUTCFullYear(), new Date(nextStart).getUTCMonth(), 1)
                    const adjCached = getMonthCache(adjMonthStart)
                    const adjList2 = gran === "week" ? adjCached?.weeks : adjCached?.days
                    adjPeriod = adjList2?.find(p => p.startMs === nextStart)
                  }
                  if (adjPeriod) {
                    modelCache.set(nextKey, {
                      models: adjPeriod.models,
                      totalInput: adjPeriod.inputTokens,
                      totalOutput: adjPeriod.outputTokens,
                      totalCost: adjPeriod.totalCost,
                    })
                  }
                }

                if (!hasLoadedOnce()) setHasLoadedOnce(true)
                if (isStale) refreshInBackground(startMs, endMs, gran)
                return
              }
            }

            // ── Fallback: cache miss (synchronous for first paint, shows spinner) ──
            runQueryPipeline(startMs, endMs, gran)
          }

          // Loads the top root sessions for the current period when the session
          // view is active. Runs on period/granularity changes (via loadData) and
          // on the `s` toggle. Sessions have no "price" sort, so "price" maps to
          // "cost"; only "tokens" keeps its own ordering.
          function loadSessionData() {
            if (!sessionView() || !db) return
            const { startMs, endMs } = computeWindow()
            const sortForSessions: "cost" | "tokens" = sortKey() === "tokens" ? "tokens" : "cost"
            const r = queryTopSessions(db, startMs, endMs, sortForSessions)
            if ("error" in r) return
            setTopSessions(r.sessions)
            setSelectedSessionIdx(0)
          }

          let cleanupKeyLayer: (() => void) | null = null

          // Single source of truth for dialog key bindings — consumed by BOTH
          // registerDialogKeyLayer and buildHelpRows (via the HelpOverlay).
          const usageBindings: KeyBinding[] = [
            { key: "left",     cmd: "usage.navLeft",     desc: "Previous" },
            { key: "right",    cmd: "usage.navRight",    desc: "Next" },
            { key: "r",        cmd: "usage.reload",      desc: "Reload" },
            { key: "t",        cmd: "usage.today",       desc: "Today" },
            { key: "m",        cmd: "usage.toggleMode",  desc: "Mode" },
            { key: "o",        cmd: "usage.toggleSort",  desc: "Sort" },
            { key: "g",        cmd: "usage.trends",      desc: "Trends" },
            { key: "s",        cmd: "usage.toggleSessionView", desc: "Session View" },
            { key: "enter",    cmd: "usage.openSession",  desc: "Open Session" },
            { key: "e",        cmd: "usage.export",      desc: "Export" },
            { key: "h",        cmd: "usage.help",        desc: "Help" },
            { key: "escape",   cmd: "usage.escape",      desc: "Close" },
            { key: "up",       cmd: "usage.scrollUp",    desc: "Scroll up" },
            { key: "down",     cmd: "usage.scrollDown",  desc: "Scroll down" },
            { key: "pageup",   cmd: "usage.pageUp",      desc: "Page up" },
            { key: "pagedown", cmd: "usage.pageDown",    desc: "Page down" },
          ]

          const exportable: Exportable = {
            formats: EXPORT_FORMATS,
            build: (format) => {
              const data = viewState()
              if (typeof data !== "object" || data === null) return ""
              const currentSort = sortKey()
              const sortedModels = sortModels(data.models, currentSort)
              const { startMs, endMs } = computeWindow()
              const period: ExportPeriod = {
                start: new Date(startMs).toISOString().slice(0, 10),
                end: new Date(endMs - 1).toISOString().slice(0, 10),
                granularity: granularity(),
              }
              const state = resolveProjection(data.totalCost, granularity() === "month" && monthOffset() === 0, getDayOfMonth(), getDaysInMonth())
              const projection = state.kind === "projected" ? state.projection : null
              const exportData = buildExportData(data, sortedModels, period, currentSort, projection, periodStats(), computeTrends())
              return buildExport(format, exportData)
            },
          }
          let exporter: ExportController | null = null

          function handleKey(key: string) {
            if (exporter?.handleKey(key)) return true
            if (showHelp()) {
              if (key === "h" || key === "escape") {
                setShowHelp(false)
              }
              return true
            }
            if (key === "g") {
              setShowTrends(v => !v)
              return true
            }
            if (key === "h") {
              setShowHelp(v => !v)
              return true
            }
            if (key === "e") {
              exporter?.open()
              return true
            }
            if (key === "escape") {
              api.ui.dialog.clear()
              return true
            }
            if (key === "left") {
              if (granularity() === "month") {
                if (monthOffset() <= minMonthOffset()) return true
                setMonthOffset(p => p - 1)
              } else if (granularity() === "week") {
                if (weekOffset() <= minWeekOffset()) return true
                setWeekOffset(p => p - 1)
              } else {
                if (dayOffset() <= minDayOffset()) return true
                setDayOffset(p => p - 1)
              }
              scroll.scrollToTop()
              loadData()
              return true
            }
            if (key === "right") {
              if (granularity() === "month") {
                if (monthOffset() >= 0) return true
                setMonthOffset(p => p + 1)
              } else if (granularity() === "week") {
                if (weekOffset() >= 0) return true
                setWeekOffset(p => p + 1)
              } else {
                if (dayOffset() >= 0) return true
                setDayOffset(p => p + 1)
              }
              scroll.scrollToTop()
              loadData()
              return true
            }
            if (key === "r") {
              const { startMs } = computeWindow()
              const gran = granularity()
              const isCurrent = gran === "month"
                ? isCurrentMonth(startMs)
                : gran === "week"
                  ? weekOffset() === 0
                  : dayOffset() === 0
              if (isCurrent) {
                modelCache.delete(modelCacheKey(gran, startMs))
                loadData(true)
              }
              return true
            }
            if (key === "t") {
              if (granularity() === "month") {
                if (monthOffset() === 0) return true
                setMonthOffset(0)
              } else if (granularity() === "week") {
                if (weekOffset() === 0) return true
                setWeekOffset(0)
              } else {
                if (dayOffset() === 0) return true
                setDayOffset(0)
              }
              scroll.scrollToTop()
              loadData()
              return true
            }
            if (key === "m") {
              if (granularity() === "month") {
                setGranularity("week")
                if (monthOffset() !== 0) {
                  const m = now.getUTCMonth() + monthOffset()
                  const y = now.getUTCFullYear() + Math.floor(m / 12)
                  const month = ((m % 12) + 12) % 12
                  const monthStart = Date.UTC(y, month, 1)
                  const targetMonday = getWeekMonday(new Date(monthStart + 7 * MS_PER_DAY)).getTime()
                  const currentMonday = getWeekMonday(new Date()).getTime()
                  const diffWeeks = Math.round((targetMonday - currentMonday) / (7 * MS_PER_DAY))
                  setWeekOffset(diffWeeks > 0 ? Math.min(diffWeeks, 0) : Math.max(diffWeeks, minWeekOffset()))
                }
              } else if (granularity() === "week") {
                setGranularity("day")
                if (weekOffset() !== 0) {
                  const currentMonday = getWeekMonday(new Date())
                  const targetMonday = new Date(currentMonday.getTime() + weekOffset() * 7 * MS_PER_DAY + MS_PER_DAY)
                  const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
                  const targetDayStart = Date.UTC(targetMonday.getUTCFullYear(), targetMonday.getUTCMonth(), targetMonday.getUTCDate())
                  const diffDays = Math.round((targetDayStart - currentDayStart) / MS_PER_DAY)
                  setDayOffset(diffDays > 0 ? Math.min(diffDays, 0) : Math.max(diffDays, minDayOffset()))
                }
              } else {
                setGranularity("month")
                if (dayOffset() !== 0) {
                  const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
                  const targetDayMs = currentDayStart + dayOffset() * MS_PER_DAY
                  const d = new Date(targetDayMs)
                  const currentYear = now.getUTCFullYear()
                  const currentMonth = now.getUTCMonth()
                  const newMonthOffset = (d.getUTCFullYear() * 12 + d.getUTCMonth()) - (currentYear * 12 + currentMonth)
                  setMonthOffset(newMonthOffset > 0 ? Math.min(newMonthOffset, 0) : Math.max(newMonthOffset, minMonthOffset()))
                }
              }
              scroll.scrollToTop()
              loadData()
              return true
            }
            if (key === "o") {
              if (sessionView()) {
                setSortKey(k => toggleSessionSort(k === "tokens" ? "tokens" : "cost"))
                loadSessionData()
              } else {
                setSortKey(k => k === "tokens" ? "cost" : k === "cost" ? "price" : "tokens")
              }
              return true
            }
            if (key === "s") {
              setSessionView(v => !v)
              loadSessionData()
              return true
            }
            if (key === "enter" && sessionView()) {
              const list = topSessions()
              const s = list[selectedSessionIdx()]
              if (s) openAnalyze(api, s.id)
              return true
            }
            if (key === "up" && sessionView()) {
              const idx = selectedSessionIdx()
              if (idx > 0) {
                setSelectedSessionIdx(idx - 1)
                setTimeout(() => scrollSessionIntoView(), 50)
              }
              return true
            }
            if (key === "down" && sessionView()) {
              const idx = selectedSessionIdx()
              if (idx < topSessions().length - 1) {
                setSelectedSessionIdx(idx + 1)
                setTimeout(() => scrollSessionIntoView(), 50)
              }
              return true
            }
            if (key === "up") {
              return scroll.handleUp()
            }
            if (key === "down") {
              return scroll.handleDown()
            }
            if (key === "pageup")   { return scroll.handlePageUp() }
            if (key === "pagedown") { return scroll.handlePageDown() }
            return false
          }

          api.ui.dialog.replace(() => {
            // The export controller must be created inside this Solid owner so its
            // createEffect (priority-2 key layer) and onCleanup (flash timeout) are
            // disposed when the dialog closes.
            exporter = createExportController(api, exportable)
            // Desired large/40 — falls back to fit the terminal (never cut off).
            const dialogSizing = useDialogSizing(api, { size: "large", maxHeight: 40 })
            log(
              "[mu:usage] dialog open",
              `renderer=${api.renderer ? "present" : "missing"}`,
              `geometry w=${api.renderer?.width} h=${api.renderer?.height}`,
              `terminal w=${api.renderer?.terminalWidth} h=${api.renderer?.terminalHeight}`,
              `stdout w=${process.stdout.columns} h=${process.stdout.rows}`,
            )
            createEffect(() => {
              const fit = dialogSizing()
              api.ui.dialog.setSize(fit.size)
              log("[mu:usage] sizing", fit.size, fit.maxHeight)
              const el = scroll.scrollRef
              if (el) {
                setTimeout(() => {
                  log(
                    "[mu:usage] el-state",
                    `height=${(el as any).height}`,
                    `viewport=${(el as any).viewport?.height}`,
                    `content=${(el as any).content?.height}`,
                  )
                }, 250)
              }
            })

            const { label } = computeWindow()
            const gran = granularity()
            const offset = gran === "month" ? monthOffset() : gran === "week" ? weekOffset() : dayOffset()
            const minOffset = gran === "month" ? minMonthOffset() : gran === "week" ? minWeekOffset() : minDayOffset()

            let arrows: string
            if (minOffset === 0) {
              arrows = ""
            } else if (offset >= 0) {
              arrows = " \u2190"
            } else if (offset <= minOffset) {
              arrows = " \u2192"
            } else {
              arrows = " \u2190 \u2192"
            }

            // The export overlay's priority-2 key layer (up/down/enter/escape/e)
            // is owned by the shared export controller now.

            onMount(() => {
              cleanupKeyLayer = registerDialogKeyLayer(api, {
                priority: 1,
                bindings: usageBindings,
                commands: [
                  { name: "usage.navLeft",     title: "Previous",       run: async () => { handleKey("left") } },
                  { name: "usage.navRight",    title: "Next",           run: async () => { handleKey("right") } },
                  { name: "usage.reload",      title: "Reload Usage",   run: async () => { handleKey("r") } },
                  { name: "usage.today",       title: "Today",          run: async () => { handleKey("t") } },
                  { name: "usage.toggleMode",  title: "Toggle Mode",    run: async () => { handleKey("m") } },
                  { name: "usage.toggleSort",  title: "Toggle Sort",    run: async () => { handleKey("o") } },
                  { name: "usage.trends",      title: "Toggle Trends",    run: async () => { handleKey("g") } },
                  { name: "usage.toggleSessionView", title: "Toggle Session View", run: async () => { handleKey("s") } },
                  { name: "usage.openSession", title: "Open Session", run: async () => { handleKey("enter") } },
                  { name: "usage.export",      title: "Export",         run: async () => { handleKey("e") } },
                  { name: "usage.help",        title: "Toggle Help",    run: async () => { handleKey("h") } },
                  { name: "usage.escape",      title: "Close",          run: async () => { handleKey("escape") } },
                  { name: "usage.scrollUp",    title: "Scroll Up",      run: async () => { handleKey("up") } },
                  { name: "usage.scrollDown",  title: "Scroll Down",    run: async () => { handleKey("down") } },
                  { name: "usage.pageUp",   title: "Page Up",   run: async () => { handleKey("pageup") } },
                  { name: "usage.pageDown", title: "Page Down", run: async () => { handleKey("pagedown") } },
                ],
              })
              loadData()
              setTimeout(() => {
                if (cleanedUp) return
                ensureMessageTimeIndex(dbPath)
                if (!db) return
                const earliestMs = getEarliestUsageDate(db)
                if (earliestMs != null) {
                  const off = computeMinOffsets(earliestMs, new Date())
                  setMinMonthOffset(off.minMonthOffset)
                  setMinWeekOffset(off.minWeekOffset)
                  setMinDayOffset(off.minDayOffset)
                  setCachedEarliestTs(earliestMs)
                }
                backfillNullCounts()
              }, 0)
            })
            onCleanup(() => {
              if (cleanupKeyLayer) {
                try { cleanupKeyLayer() } catch { /* ignore */ }
                cleanupKeyLayer = null
              }
            })

            return (
              <>
              <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="row" gap={1}>
                    <text fg={fg}><b>Usage{gran === "week" ? " / weekly" : gran === "day" ? " / daily" : ""}</b></text>
                    <text fg={muted}>{gran === "week" ? `\u2014 ${label}` : label}{arrows}</text>
                    {periodStats() && (
                      <text fg={muted}>{`\u00b7 ${periodStats()!.sessions} sessions \u00b7 ${periodStats()!.messages} messages`}</text>
                    )}
                  </box>
                  <text fg={muted}>esc</text>
                </box>
                {(() => {
                  const data = viewState()
                  const hasOverflow = data && typeof data === "object" && !("error" in data) && data.models.length > 5
                  return (
                    <text fg={muted}>{hasOverflow && scroll.isScrolled() ? "\u25b2 more above" : " "}</text>
                  )
                })()}
                <scrollbox ref={(el) => scroll.scrollRef = el} maxHeight={dialogSizing().maxHeight} scrollbarOptions={{ visible: false }}>
                  {viewState() === "loading" ? (
                    <text fg={muted}>Loading usage data{"\u2026"}</text>
                  ) : viewState() === "error" ? (
                    <box flexDirection="column" gap={1}>
                      <text fg={red}><b>Error Fetching Usage</b></text>
                      <text fg={muted}>{errorMsg()}</text>
                    </box>
                  ) : sessionView() ? (
                    (() => {
                      const list = topSessions()
                      const sortForSessions = sortKey() === "tokens" ? "tokens" : "cost"
                      if (list.length === 0) {
                        return <text fg={muted}>{"\u2014"} No root sessions for {label}</text>
                      }
                      return (
                        <box paddingBottom={0} flexDirection="column" gap={0}>
                          <text fg={fg}><b>Top Sessions</b> (top {list.length} · sorted by {sortForSessions})</text>
                          {list.map((s, i) => {
                            const selected = i === selectedSessionIdx()
                            const title = s.title || "(untitled)"
                            return (
                              <box key={s.id} data-session-idx={i} flexDirection="column" gap={0}>
                                <text fg={selected ? primary : fg}>{i + 1}. {title}</text>
                                <text fg={muted}>
                                  {fmt(s.tokens)} tokens{s.cost > 0 ? ` \u2014 ${fmtCost(s.cost)}` : ""}{s.subagentCount > 0 ? ` \u00b7 ${s.subagentCount} subagents` : ""}
                                </text>
                              </box>
                            )
                          })}
                        </box>
                      )
                    })()
                  ) : (
                    (() => {
                      const data = viewState() as UsageData
                      const { models, totalInput, totalOutput, totalCost } = data
                      const sortedModels = sortModels(models, sortKey())
                      const totalTokens = totalInput + totalOutput
                      const moneySort = sortKey() === "cost" || sortKey() === "price"
                      const shareTotal = moneySort ? totalCost : totalTokens
                      const hasCost = totalCost > 0
                      const emptyResult = models.length === 0
                      const trends = showTrends()

                      const summary = (
                        <>
                          <text fg={fg}>Total: {fmt(totalTokens)} tokens{hasCost ? ` (${fmtCost(totalCost)})` : ""}{(() => {
                            const d = diffInfo()
                            if (d.text === "\u2014") return ""
                            return `  ${d.arrow} ${d.text}`
                          })()}</text>
                          <text fg={muted}>  {"\u2191"} Input:  {fmt(totalInput)} tokens</text>
                          <text fg={muted}>  {"\u2193"} Output: {fmt(totalOutput)} tokens</text>
                          {(() => {
                            const state = resolveProjection(totalCost, granularity() === "month" && monthOffset() === 0, getDayOfMonth(), getDaysInMonth())
                            switch (state.kind) {
                              case "calculating":
                                return <text fg={muted}>  calculating projection... {state.daysLeft} {state.daysLeft === 1 ? "day" : "days"} to show</text>
                              case "projected":
                                return <text fg={muted}>  on pace: {fmtCost(state.projection.projectedCost)} by end of month</text>
                              default:
                                return null
                            }
                          })()}
                        </>
                      )

                      if (trends) {
                        const series = trendSeries()!
                        const max = Math.max(...series.values)
                        const labelPad = Math.max(0, ...series.labels.map(l => l.length))
                        const windowDesc = `last ${series.values.length} ${gran === "month" ? "months" : gran === "week" ? "weeks" : "days"}`
                        return (
                          <box paddingBottom={1}>
                            {summary}
                            <text> </text>
                            <box flexDirection="row" gap={1}>
                              <text fg={fg}><b>Trends</b></text>
                              <text fg={muted}>· {windowDesc}</text>
                            </box>
                            <text> </text>
                            {series.values.map((v, i) => {
                              const pct = max > 0 ? (v / max) * 100 : 0
                              return (
                                <box flexDirection="row" gap={2}>
                                  <text fg={fg}>{series.labels[i].padEnd(labelPad)}</text>
                                  <text fg={fg}>{buildBar(pct, 30)}</text>
                                  <text fg={muted}>{fmtCompact(v)}</text>
                                </box>
                              )
                            })}
                            <text> </text>
                            {series.peakWeekday && <text fg={muted}>Most used on: {series.peakWeekday}</text>}
                          </box>
                        )
                      }

                      return emptyResult ? (
                        <text fg={muted}>{"\u2014"} No activity for {label}</text>
                      ) : (
                        <box paddingBottom={1}>
                          {summary}
                          <text> </text>
                          <text fg={fg}><b>Per Model</b> (top {models.length} · sorted by {sortKey()})</text>
                          <text> </text>
                          {sortedModels.map((m, i) => {
                            const modelTokens = m.totalInput + m.totalOutput
                            const shareValue = moneySort ? m.totalCost : modelTokens
                            const pct = shareTotal > 0 ? (shareValue / shareTotal) * 100 : 0
                            const displayName = `${m.providerID}/${m.modelID}`
                            const modelHasCost = m.totalCost > 0
                            const cpm = costPerMillion(m)
                            const eff = cpm === null ? "" : (m.totalCost === 0 ? " \u00b7 free" : ` \u00b7 ${fmtCostPerMillion(cpm)}`)
                            return (
                              <box key={m.providerID + "/" + m.modelID} flexDirection="column" gap={1}>
                                <text fg={fg}>{i + 1}. {displayName}</text>
                                <text fg={muted}>
                                  {moneySort
                                    ? `${fmt(modelTokens)} tokens${modelHasCost ? ` \u2014 ${fmtCost(m.totalCost)}` : ""} (${pct.toFixed(1)}%)${eff}`
                                    : `${fmt(modelTokens)} tokens (${pct.toFixed(1)}%)${modelHasCost ? ` \u2014 ${fmtCost(m.totalCost)}` : ""}${eff}`}
                                </text>
                                <text fg={fg}>{buildBar(pct, 50)}</text>
                                {i < models.length - 1 && <text> </text>}
                              </box>
                            )
                          })}
                        </box>
                      )
                    })()
                  )}
                </scrollbox>
                {(() => {
                  const data = viewState()
                  const hasOverflow = data && typeof data === "object" && !("error" in data) && data.models.length > 5
                  return (
                    <text fg={muted}>{hasOverflow && !scroll.isAtBottom() ? "\u25bc more below" : " "}</text>
                  )
                })()}
                {hasLoadedOnce() && (
                  <box flexDirection="row" gap={1}>
                    {sessionView() ? (
                      <>
                        <text fg={muted}>↑↓</text>
                        <text fg={muted}>navigate</text>
                        <text fg={muted}>·</text>
                        <text fg={muted}>enter</text>
                        <text fg={muted}>analyze</text>
                      </>
                    ) : (
                      <>
                        <text fg={muted}>← →</text>
                        <text fg={muted}>{gran}</text>
                        <text fg={muted}>·</text>
                        <text fg={muted}>↑↓</text>
                        <text fg={muted}>scroll</text>
                      </>
                    )}
                    <text fg={muted}>·</text>
                    <CopiedFlash copied={exporter!.copiedFlash()} hint="e export" muted={muted} primary={muted} />
                    <text fg={muted}>·</text>
                    <text fg={muted}>h</text>
                    <text fg={muted}>help</text>
                  </box>
                )}
              </box>
              {showHelp() && (
                <HelpOverlay rows={buildHelpRows(usageBindings)} fg={fg} muted={muted} bg={panel} title="Usage Shortcuts" name={PLUGIN_NAME} version={PLUGIN_VERSION} />
              )}
              {exporter!.renderOverlay()}
              </>
            )
          }, () => {
            cleanedUp = true
            if (cleanupKeyLayer) {
              try { cleanupKeyLayer() } catch { /* ignore */ }
              cleanupKeyLayer = null
            }
            flushDiskSave()
            if (db) {
              try { db.close() } catch { /* ignore */ }
              db = null
            }
          })
        },
      },
    ],
    bindings: [
      {
        key: "ctrl+shift+u",
        cmd: "usage.show",
        desc: "Show Monthly Usage",
      },
    ],
  })
}
