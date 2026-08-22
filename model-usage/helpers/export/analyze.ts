/**
 * Analyze export serializers — the analyze-specific types, builders, and
 * formatting helpers, following the same conventions as the usage export
 * (`helpers/export/usage.ts`) on top of the wlib foundation (`wlib/export`).
 *
 * The analyze dialog exports its FULL analysis summary: the per-category
 * token breakdown, model stats, compaction summary, session cost, hotspots,
 * the tool-defs and synthetic token counts, plus the complete raw system
 * prompt and raw tool-definition text (preserved in full, not truncated).
 *
 * Pure and deterministic: no side effects, no imports from any host plugin,
 * no Node/runtime dependencies. Type-only imports are erased at compile time,
 * so this stays unit-testable in isolation. Named exports only.
 */

import { EXPORT_FORMATS, type ExportFormat } from "../../wlib/src/core/export"
import type { AnalysisData, Category, CategoryEntry, FormattedHotspotResult } from "../../analyze-domain"
import type { ModelStat } from "../models"
import type { CompactionSummary } from "../compaction"

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single token-counted entry within a category (e.g. `User #1`). */
export interface AnalyzeExportCategoryEntry {
  label: string
  tokens: number
}

/** A token category with its entries and the category total. */
export interface AnalyzeExportCategory {
  name: string
  entries: AnalyzeExportCategoryEntry[]
  totalTokens: number
}

/** Aggregated per-provider/model usage within the session. */
export interface AnalyzeExportModelStat {
  providerID: string
  modelID: string
  msgCount: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  cost: number
  peakInputTokens: number
}

/** Compaction summary (count / measured / reduction tokens). */
export interface AnalyzeExportCompaction {
  count: number
  measured: number
  reductionTokens: number
}

/** An unusually large message hotspot. */
export interface AnalyzeExportHotspot {
  category: string
  label: string
  tokens: number
  ratio: number
  formattedRatio: string
}

/** A top contributor entry (label + estimated tokens). */
export interface AnalyzeExportTopContributor {
  label: string
  tokens: number
}

/**
 * The complete analyze summary ready to be serialized to any export format.
 * `rawSystemText` and `rawToolDefsText` are preserved in FULL — no truncation.
 */
export interface AnalyzeExportData {
  sessionID: string
  messageCount: number
  estimatedTotal: number
  hasToolsSection: boolean
  categories: AnalyzeExportCategory[]
  topContributors: AnalyzeExportTopContributor[]
  modelStats: AnalyzeExportModelStat[]
  switchesCount: number
  compaction: AnalyzeExportCompaction | null
  sessionCost: number
  hotspotResults: AnalyzeExportHotspot[]
  toolDefsTokens: number
  syntheticTokens: number
  rawSystemText: string
  rawToolDefsText: string
}

/**
 * The formats the analyze dialog offers. The generic `EXPORT_FORMATS`
 * includes CSV, but analyze data (nested categories + raw text blobs) doesn't
 * map cleanly onto a flat CSV table — so only Markdown / JSON / plain text.
 */
export const ANALYZE_EXPORT_FORMATS = EXPORT_FORMATS.filter((f) => f.id !== "csv")

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format an integer-like count with thousands separators (e.g. `1,234,567`).
 * Deterministic and locale-independent.
 */
function formatThousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/**
 * Compute a Markdown fenced-code fence that cannot collide with the longest
 * run of backticks inside `content`. Returns a backtick run one longer than
 * the longest backtick run in `content` (minimum three), so a raw section
 * containing triple backticks (or longer runs) never prematurely closes the
 * fence. This guarantees the raw content is retained in full.
 */
function markdownFence(content: string): string {
  let longest = 0
  let current = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 96 /* ` */) {
      current++
      if (current > longest) longest = current
    } else {
      current = 0
    }
  }
  return "`".repeat(Math.max(3, longest + 1))
}

/** Round a number to two decimal places (used for cost and percentages). */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Format a USD cost: `$1,234.56` (two decimals). */
function formatCost(n: number): string {
  return `$${round2(n).toFixed(2)}`
}

/** Format a token count as `1,234 tokens`. */
function formatTokens(n: number): string {
  return `${formatThousands(n)} tokens`
}

// ─── Builders ────────────────────────────────────────────────────────────────

/**
 * Serialize `data` to a Markdown document: a header with the session summary,
 * the estimated total, a per-category table, per-category entry breakdowns,
 * model stats, top contributors, compaction, session cost, hotspots, the
 * tool-defs/synthetic token counts, and the full raw system + tool-defs text
 * in fenced code blocks.
 */
export function buildMarkdown(data: AnalyzeExportData): string {
  const lines: string[] = [
    `## Analyze · Session ${data.sessionID} · ${formatThousands(data.messageCount)} messages`,
    "",
    `Estimated total: ${formatTokens(data.estimatedTotal)}`,
    "",
  ]

  // ── Categories table ──────────────────────────────────────────────────────
  if (data.categories.length > 0) {
    lines.push("| Category | Tokens | % |")
    lines.push("| --- | ---: | ---: |")
    for (const cat of data.categories) {
      const pct = data.estimatedTotal > 0 ? (cat.totalTokens / data.estimatedTotal) * 100 : 0
      lines.push(`| ${escapeMarkdownCell(cat.name)} | ${formatThousands(cat.totalTokens)} | ${round2(pct).toFixed(1)}% |`)
    }
    lines.push("")

    // Per-category entry breakdown
    for (const cat of data.categories) {
      lines.push(`### ${cat.name}`)
      lines.push("")
      lines.push("| Entry | Tokens |")
      lines.push("| --- | ---: |")
      for (const entry of cat.entries) {
        lines.push(`| ${escapeMarkdownCell(entry.label)} | ${formatThousands(entry.tokens)} |`)
      }
      lines.push("")
    }
  }

  // ── Top contributors ──────────────────────────────────────────────────────
  if (data.topContributors.length > 0) {
    lines.push("## Top Contributors")
    lines.push("")
    lines.push("| Entry | Tokens |")
    lines.push("| --- | ---: |")
    for (const entry of data.topContributors) {
      lines.push(`| ${escapeMarkdownCell(entry.label)} | ${formatThousands(entry.tokens)} |`)
    }
    lines.push("")
  }

  // ── Model stats ───────────────────────────────────────────────────────────
  if (data.modelStats.length > 0) {
    lines.push("## Models in Session")
    lines.push("")
    lines.push("| Provider | Model | Messages | Input | Output | Cache read | Cache write | Peak input | Cost |")
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for (const m of data.modelStats) {
      lines.push(
        `| ${escapeMarkdownCell(m.providerID)} | ${escapeMarkdownCell(m.modelID)} | ${m.msgCount} | ` +
          `${formatThousands(m.inputTokens)} | ${formatThousands(m.outputTokens)} | ` +
          `${formatThousands(m.cacheRead)} | ${formatThousands(m.cacheWrite)} | ` +
          `${formatThousands(m.peakInputTokens)} | ${formatCost(m.cost)} |`
      )
    }
    lines.push("")
    if (data.switchesCount > 0) {
      lines.push(`Model switches: ${data.switchesCount}`)
      lines.push("")
    }
  }

  // ── Compaction ────────────────────────────────────────────────────────────
  if (data.compaction && data.compaction.count > 0) {
    const reductionText = data.compaction.reductionTokens > 0 ? `, -${formatThousands(data.compaction.reductionTokens)} tokens` : ""
    const pendingCount = data.compaction.count - data.compaction.measured
    const pendingText = pendingCount > 0 && pendingCount < data.compaction.count ? ` (${pendingCount} pending)` : ""
    lines.push(`## Compactions`)
    lines.push("")
    lines.push(`${data.compaction.count}${reductionText}${pendingText}`)
    lines.push("")
  }

  // ── Session cost ──────────────────────────────────────────────────────────
  if (data.sessionCost > 0) {
    lines.push(`## Session cost`)
    lines.push("")
    lines.push(formatCost(data.sessionCost))
    lines.push("")
  }

  // ── Tool defs / synthetic tokens ──────────────────────────────────────────
  if (data.toolDefsTokens > 0 || data.syntheticTokens > 0) {
    lines.push("## Token Composition")
    lines.push("")
    lines.push(`Tool definitions: ${formatTokens(data.toolDefsTokens)}`)
    lines.push(`Synthetic content: ${formatTokens(data.syntheticTokens)}`)
    lines.push("")
  }

  // ── Hotspots ──────────────────────────────────────────────────────────────
  if (data.hotspotResults.length > 0) {
    lines.push("## Unusually Large Messages")
    lines.push("")
    lines.push("| Category | Label | Tokens | Ratio |")
    lines.push("| --- | --- | ---: | ---: |")
    for (const h of data.hotspotResults) {
      lines.push(
        `| ${escapeMarkdownCell(h.category)} | ${escapeMarkdownCell(h.label)} | ` +
          `${formatThousands(h.tokens)} | ${h.formattedRatio}x avg |`
      )
    }
    lines.push("")
  }

  // ── Raw text (preserved in full) ──────────────────────────────────────────
  if (data.rawSystemText) {
    lines.push("## Raw System Prompt")
    lines.push("")
    const fence = markdownFence(data.rawSystemText)
    lines.push(fence)
    lines.push(data.rawSystemText)
    lines.push(fence)
    lines.push("")
  }
  if (data.rawToolDefsText) {
    lines.push("## Raw Tool Definitions")
    lines.push("")
    const fence = markdownFence(data.rawToolDefsText)
    lines.push(fence)
    lines.push(data.rawToolDefsText)
    lines.push(fence)
  }

  return lines.join("\n")
}

/**
 * Serialize `data` to pretty-printed JSON (2-space indent). Cost and the
 * hotspot ratio are rounded to two decimals; token counts and raw text are
 * preserved exactly (raw system/tool-defs text in full).
 */
export function buildJson(data: AnalyzeExportData): string {
  return JSON.stringify(
    {
      sessionID: data.sessionID,
      messageCount: data.messageCount,
      estimatedTotal: data.estimatedTotal,
      hasToolsSection: data.hasToolsSection,
      toolDefsTokens: data.toolDefsTokens,
      syntheticTokens: data.syntheticTokens,
      sessionCost: round2(data.sessionCost),
      categories: data.categories.map((cat) => ({
        name: cat.name,
        totalTokens: cat.totalTokens,
        entries: cat.entries.map((e) => ({ label: e.label, tokens: e.tokens })),
      })),
      topContributors: data.topContributors.map((e) => ({ label: e.label, tokens: e.tokens })),
      modelStats: data.modelStats.map((m) => ({
        providerID: m.providerID,
        modelID: m.modelID,
        msgCount: m.msgCount,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cacheRead: m.cacheRead,
        cacheWrite: m.cacheWrite,
        peakInputTokens: m.peakInputTokens,
        cost: round2(m.cost),
      })),
      switchesCount: data.switchesCount,
      compaction: data.compaction
        ? {
            count: data.compaction.count,
            measured: data.compaction.measured,
            reductionTokens: data.compaction.reductionTokens,
          }
        : null,
      hotspotResults: data.hotspotResults.map((h) => ({
        category: h.category,
        label: h.label,
        tokens: h.tokens,
        ratio: round2(h.ratio),
        formattedRatio: h.formattedRatio,
      })),
      rawSystemText: data.rawSystemText,
      rawToolDefsText: data.rawToolDefsText,
    },
    null,
    2
  )
}

/**
 * Serialize `data` to a human-readable plain-text dump (no Markdown syntax).
 * Mirrors the Markdown content but without table pipes or headings. Raw
 * system/tool-defs text is preserved in full.
 */
export function buildText(data: AnalyzeExportData): string {
  const lines: string[] = [
    `Analyze · Session ${data.sessionID} · ${formatThousands(data.messageCount)} messages`,
    `Estimated total: ${formatTokens(data.estimatedTotal)}`,
    "",
  ]

  for (const cat of data.categories) {
    const pct = data.estimatedTotal > 0 ? (cat.totalTokens / data.estimatedTotal) * 100 : 0
    lines.push(`${cat.name} — ${formatTokens(cat.totalTokens)} (${round2(pct).toFixed(1)}%)`)
    for (const entry of cat.entries) {
      lines.push(`  ${entry.label}  ${formatTokens(entry.tokens)}`)
    }
    lines.push("")
  }

  if (data.topContributors.length > 0) {
    lines.push("Top Contributors")
    data.topContributors.forEach((e, i) => {
      lines.push(`  ${String(i + 1).padStart(2)}. ${e.label}  ${formatTokens(e.tokens)}`)
    })
    lines.push("")
  }

  if (data.modelStats.length > 0) {
    lines.push("Models in Session")
    for (const m of data.modelStats) {
      lines.push(
        `  ${m.providerID} / ${m.modelID} — ${m.msgCount} msgs · ` +
          `${formatTokens(m.inputTokens)} input · ${formatTokens(m.outputTokens)} output · ` +
          `${formatThousands(m.cacheRead)} cache read · ${formatThousands(m.cacheWrite)} cache write · ` +
          `${formatTokens(m.peakInputTokens)} peak input · ${formatCost(m.cost)}`
      )
    }
    if (data.switchesCount > 0) {
      lines.push(`Model switches: ${data.switchesCount}`)
    }
    lines.push("")
  }

  if (data.compaction && data.compaction.count > 0) {
    const reductionText = data.compaction.reductionTokens > 0 ? `, -${formatThousands(data.compaction.reductionTokens)} tokens` : ""
    const pendingCount = data.compaction.count - data.compaction.measured
    const pendingText = pendingCount > 0 && pendingCount < data.compaction.count ? ` (${pendingCount} pending)` : ""
    lines.push(`Compactions: ${data.compaction.count}${reductionText}${pendingText}`)
    lines.push("")
  }

  if (data.sessionCost > 0) {
    lines.push(`Session cost: ${formatCost(data.sessionCost)}`)
    lines.push("")
  }

  if (data.toolDefsTokens > 0 || data.syntheticTokens > 0) {
    lines.push(`Tool definitions: ${formatTokens(data.toolDefsTokens)}`)
    lines.push(`Synthetic content: ${formatTokens(data.syntheticTokens)}`)
    lines.push("")
  }

  if (data.hotspotResults.length > 0) {
    lines.push("Unusually Large Messages")
    for (const h of data.hotspotResults) {
      lines.push(`  ${h.label}  ${formatTokens(h.tokens)}  (${h.formattedRatio}x avg)`)
    }
    lines.push("")
  }

  if (data.rawSystemText) {
    lines.push("Raw System Prompt")
    lines.push("----------------------------------------")
    lines.push(data.rawSystemText)
    lines.push("")
  }
  if (data.rawToolDefsText) {
    lines.push("Raw Tool Definitions")
    lines.push("----------------------------------------")
    lines.push(data.rawToolDefsText)
  }

  return lines.join("\n")
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Dispatch to the builder matching `format` and return its serialized output.
 * CSV is intentionally unsupported for analyze data.
 */
export function buildAnalyzeExport(format: ExportFormat, data: AnalyzeExportData): string {
  switch (format) {
    case "markdown":
      return buildMarkdown(data)
    case "json":
      return buildJson(data)
    case "text":
      return buildText(data)
    case "csv":
      throw new Error("Analyze export does not support CSV")
    default:
      throw new Error(`Unknown export format: ${String(format)}`)
  }
}

// ─── Assembler ───────────────────────────────────────────────────────────────

/**
 * Pure, testable builder that assembles an `AnalyzeExportData` from a live
 * `AnalysisData`. Extracted so the export wiring in analyze.tsx stays thin and
 * the shape (including every `AnalysisData` field, the tool-defs/synthetic
 * token counts, and the full raw texts) is guaranteed, not assembled ad hoc.
 */
export function buildAnalyzeExportData(data: AnalysisData, sessionID: string): AnalyzeExportData {
  return {
    sessionID,
    messageCount: data.messageCount,
    estimatedTotal: data.estimatedTotal,
    hasToolsSection: data.hasToolsSection,
    categories: mapCategories(data.categories),
    topContributors: data.topContributors.map((e) => ({ label: e.label, tokens: e.tokens })),
    modelStats: data.modelStats.map(mapModelStat),
    switchesCount: data.switchesCount,
    compaction: mapCompaction(data.compactionSummary),
    sessionCost: data.sessionCost,
    hotspotResults: data.hotspotResults.map(mapHotspot),
    toolDefsTokens: data.toolDefsTokens,
    syntheticTokens: data.syntheticTokens,
    rawSystemText: data.rawSystemText,
    rawToolDefsText: data.rawToolDefsText,
  }
}

// ─── Mapping helpers ─────────────────────────────────────────────────────────

function mapCategories(categories: Category[]): AnalyzeExportCategory[] {
  return categories.map((cat) => ({
    name: cat.name,
    totalTokens: cat.totalTokens,
    entries: cat.entries.map((e: CategoryEntry) => ({ label: e.label, tokens: e.tokens })),
  }))
}

function mapModelStat(m: ModelStat): AnalyzeExportModelStat {
  return {
    providerID: m.providerID,
    modelID: m.modelID,
    msgCount: m.msgCount,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheRead: m.cacheRead,
    cacheWrite: m.cacheWrite,
    cost: m.cost,
    peakInputTokens: m.peakInputTokens,
  }
}

function mapCompaction(summary: CompactionSummary | null): AnalyzeExportCompaction | null {
  if (!summary) return null
  return {
    count: summary.count,
    measured: summary.measured,
    reductionTokens: summary.reductionTokens,
  }
}

function mapHotspot(h: FormattedHotspotResult): AnalyzeExportHotspot {
  return {
    category: h.category,
    label: h.label,
    tokens: h.tokens,
    ratio: h.ratio,
    formattedRatio: h.formattedRatio,
  }
}

/** Escape a cell value so it cannot break a Markdown table. */
function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "\\n")
}
