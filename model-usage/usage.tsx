/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"

import { onMount, onCleanup, createSignal, createEffect } from "solid-js"
import { getMonthInfo, isCurrentMonth, getWeekMonday, getWeekInfo, computeMinOffsets } from "./helpers/dates"
import { log } from "./helpers/debug"
import { fmt, fmtCost, buildBar, formatPercentDiff } from "./helpers/format"
import type { UsageData, ModelUsage } from "./types"
import { getEarliestUsageDate, fetchRawRows, queryUsage, MAX_MODELS } from "./db"
import { makeScrollState } from "./wlib/scroll"
import { registerDialogKeyLayer } from "./wlib/keys"
import { useDialogSizing } from "./wlib/dialog"
import { resolveThemeColors } from "./wlib/theme"

import { MS_PER_DAY, CACHE_TTL_MS, PREFETCH_DELAY_MS, type CachePeriod, getMonthCache, scheduleDiskSave, flushDiskSave, updateMonthCache, getCachedEarliestTs, setCachedEarliestTs } from "./cache"
import { type Granularity, computeUsageDataFromRows, buildHierarchy, findPreviousPeriodTotal } from "./usage-domain"

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

          const { fg, muted, red } = resolveThemeColors(api.theme.current)

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
          const scroll = makeScrollState(createSignal)

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

          function modelCacheKey(gran: Granularity, startMs: number): string {
            return `${gran}:${startMs}`
          }

          function computeAndSetDiff(startMs: number, currentTotal: number) {
            const prev = findPreviousPeriodTotal(startMs, granularity(), getMonthCache)
            setDiffInfo(formatPercentDiff(currentTotal, prev))
          }

          // ── Shared background pipeline (hierarchy build + forward prefetch) ──
          function scheduleHierarchyBuild(startMs: number, endMs: number, gran: Granularity) {
            if (gran !== "month") return
            setTimeout(() => {
              if (cleanedUp || !db) return
              const rowsResult = fetchRawRows(db, startMs, endMs)
              if (!("error" in rowsResult)) {
                const period = buildHierarchy(rowsResult, startMs, endMs)
                updateMonthCache(period)
              }
            }, 0)
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

          let cleanupKeyLayer: (() => void) | null = null

          function handleKey(key: string) {
            if (key === "left" || key === "h") {
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
            if (key === "right" || key === "l") {
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

            onMount(() => {
              cleanupKeyLayer = registerDialogKeyLayer(api, {
                bindings: [
                  { key: "left",  cmd: "usage.navLeft",  desc: "Previous" },
                  { key: "h",     cmd: "usage.navLeft",  desc: "Previous" },
                  { key: "right", cmd: "usage.navRight", desc: "Next" },
                  { key: "l",     cmd: "usage.navRight", desc: "Next" },
                  { key: "r",     cmd: "usage.reload",   desc: "Reload" },
                  { key: "t",     cmd: "usage.today",    desc: "Today" },
                  { key: "m",     cmd: "usage.toggleMode", desc: "Toggle mode" },
                  { key: "up",    cmd: "usage.scrollUp",   desc: "Scroll up" },
                  { key: "k",     cmd: "usage.scrollUp",   desc: "Scroll up" },
                  { key: "down",  cmd: "usage.scrollDown", desc: "Scroll down" },
                  { key: "j",     cmd: "usage.scrollDown", desc: "Scroll down" },
                  { key: "pageup",   cmd: "usage.pageUp",   desc: "Page up" },
                  { key: "pagedown", cmd: "usage.pageDown", desc: "Page down" },
                ],
                commands: [
                  { name: "usage.navLeft",     title: "Previous",       run: async () => { handleKey("left") } },
                  { name: "usage.navRight",    title: "Next",           run: async () => { handleKey("right") } },
                  { name: "usage.reload",      title: "Reload Usage",   run: async () => { handleKey("r") } },
                  { name: "usage.today",       title: "Today",          run: async () => { handleKey("t") } },
                  { name: "usage.toggleMode",  title: "Toggle Mode",    run: async () => { handleKey("m") } },
                  { name: "usage.scrollUp",    title: "Scroll Up",      run: async () => { handleKey("up") } },
                  { name: "usage.scrollDown",  title: "Scroll Down",    run: async () => { handleKey("down") } },
                  { name: "usage.pageUp",   title: "Page Up",   run: async () => { handleKey("pageup") } },
                  { name: "usage.pageDown", title: "Page Down", run: async () => { handleKey("pagedown") } },
                ],
              })
              loadData()
              setTimeout(() => {
                if (cleanedUp || !db) return
                const earliestMs = getEarliestUsageDate(db)
                if (earliestMs != null) {
                  const off = computeMinOffsets(earliestMs, new Date())
                  setMinMonthOffset(off.minMonthOffset)
                  setMinWeekOffset(off.minWeekOffset)
                  setMinDayOffset(off.minDayOffset)
                  setCachedEarliestTs(earliestMs)
                }
              }, 0)
            })
            onCleanup(() => {
              if (cleanupKeyLayer) {
                try { cleanupKeyLayer() } catch { /* ignore */ }
                cleanupKeyLayer = null
              }
            })

            return (
              <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="row" gap={1}>
                    <text fg={fg}><b>Usage{gran === "week" ? " / weekly" : gran === "day" ? " / daily" : ""}</b></text>
                    <text fg={muted}>{gran === "week" ? `\u2014 ${label}` : label}{arrows}</text>
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
                  ) : (
                    (() => {
                      const data = viewState() as UsageData
                      const { models, totalInput, totalOutput, totalCost } = data
                      const totalTokens = totalInput + totalOutput
                      const hasCost = totalCost > 0
                      const emptyResult = models.length === 0
                      return emptyResult ? (
                        <text fg={muted}>{"\u2014"} No activity for {label}</text>
                      ) : (
                        <box paddingBottom={1}>
                          <text fg={fg}>Total: {fmt(totalTokens)} tokens{hasCost ? ` (${fmtCost(totalCost)})` : ""}{(() => {
                            const d = diffInfo()
                            if (d.text === "\u2014") return ""
                            return `  ${d.arrow} ${d.text}`
                          })()}</text>
                          <text fg={muted}>  {"\u2191"} Input:  {fmt(totalInput)} tokens</text>
                          <text fg={muted}>  {"\u2193"} Output: {fmt(totalOutput)} tokens</text>
                          <text> </text>
                          <text fg={fg}><b>Per Model</b> (top {models.length})</text>
                          <text> </text>
                          {models.map((m, i) => {
                            const modelTokens = m.totalInput + m.totalOutput
                            const pct = totalTokens > 0 ? (modelTokens / totalTokens) * 100 : 0
                            const displayName = `${m.providerID}/${m.modelID}`
                            const modelHasCost = m.totalCost > 0
                            return (
                              <box key={m.providerID + "/" + m.modelID} flexDirection="column" gap={1}>
                                <text fg={fg}>{i + 1}. {displayName}</text>
                                <text fg={muted}>{fmt(modelTokens)} tokens ({pct.toFixed(1)}%){modelHasCost ? ` \u2014 ${fmtCost(m.totalCost)}` : ""}</text>
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
                  <text fg={muted}>
                    {gran === "month"
                      ? "t today  \u00b7  \u2190 \u2192 month  \u00b7  m mode  \u00b7  r reload  \u00b7  PgUp/Dn \u2191\u2193 scroll"
                      : gran === "week"
                        ? "t today  \u00b7  \u2190 \u2192 week  \u00b7  m mode  \u00b7  r reload  \u00b7  PgUp/Dn \u2191\u2193 scroll"
                        : "t today  \u00b7  \u2190 \u2192 day  \u00b7  m mode  \u00b7  r reload  \u00b7  PgUp/Dn \u2191\u2193 scroll"}
                  </text>
                )}
              </box>
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
