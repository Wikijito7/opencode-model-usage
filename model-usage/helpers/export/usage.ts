/**
 * Usage export serializers — the usage-specific types, builders, and
 * formatting helpers, consolidated from the wlib foundation (`wlib/export`)
 * plus the `buildExportData` assembler.
 *
 * Pure and deterministic: no side effects, no imports from any host plugin,
 * no Node/runtime dependencies. Named exports only so it can be unit-tested
 * in isolation.
 */

import { EXPORT_FORMATS } from "../../wlib/src/core/export"
import type { ExportFormat } from "../../wlib/src/core/export"
import type { UsageData, ModelUsage } from "../../types"
import type { ModelSortKey } from "../models"
import { costPerMillion } from "../models"

// ─── Types ───────────────────────────────────────────────────────────────────

/** Time bucket for a usage export. */
export type ExportGranularity = "month" | "week" | "day"

/** The mode used to sort the usage rows: token, cost, or price. */
export type SortMode = "tokens" | "cost" | "price"

/** Inclusive date range (`YYYY-MM-DD`) covered by an export. */
export interface ExportPeriod {
  start: string
  end: string
  granularity: ExportGranularity
}

/**
 * A single provider/model usage row. `cost` is USD as a raw number;
 * `costPerMillion` is dollars per 1M tokens: `null` when the model had zero
 * tokens (no CPM), `0` for a free (zero-cost) model, `>0` otherwise.
 */
export interface ExportRow {
  provider: string
  model: string
  input: number
  output: number
  totalTokens: number
  sharePct: number
  cost: number
  costPerMillion: number | null
}

/** Forward-looking cost projection for the period. `projectedCost` is USD. */
export interface ExportProjection {
  projectedCost: number // USD
  elapsedDays: number
  totalDays: number
}

/** Session and message counts for the covered period. */
export interface ExportPeriodStats {
  sessions: number
  messages: number
}

/**
 * Usage trend series over the period. `values` and `labels` are parallel
 * arrays, both NEWEST first. `peakWeekday` is the weekday with the max token
 * total, or `null` when no peak can be determined.
 */
export interface ExportTrends {
  values: number[] // token totals per bucket, NEWEST first
  labels: string[] // parallel per-bucket labels, NEWEST first
  peakWeekday: string | null // weekday with the max token total, or null
}

/** A complete usage summary ready to be serialized to any export format. */
export interface ExportData {
  period: ExportPeriod
  rows: ExportRow[]
  sortMode: SortMode
  totalInput: number
  totalOutput: number
  totalTokens: number
  totalCost: number
  projection: ExportProjection | null
  periodStats: ExportPeriodStats | null
  trends: ExportTrends | null
}

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
 * Round a number to two decimal places (used consistently for cost, sharePct,
 * costPerMillion, and projectedCost).
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Format a `costPerMillion` value: `null` → empty string, `0` → `free`,
 * otherwise a `$`-prefixed two-decimal `.../1M` string.
 */
function formatCostPerMillion(cpm: number | null): string {
  if (cpm === null) return ""
  if (cpm === 0) return "free"
  return `$${round2(cpm).toFixed(2)}/1M`
}

/**
 * Build the `periodStats` suffix used in the Markdown/text header line.
 * `null` → empty string, otherwise a ` · {sessions} sessions · {messages}
 * messages` suffix with the counts thousands-grouped.
 */
function formatStatsSuffix(stats: ExportPeriodStats | null): string {
  if (!stats) return ""
  return ` · ${formatThousands(stats.sessions)} sessions · ${formatThousands(stats.messages)} messages`
}

/**
 * Human-readable window description for the trends section, derived from the
 * period granularity and the actual series length: `month` → `last {count}
 * months`, `week` → `last {count} weeks`, `day` → `last {count} days`.
 */
function trendsWindowDesc(granularity: ExportGranularity, count: number): string {
  const unit = granularity === "month" ? "months" : granularity === "week" ? "weeks" : "days"
  return `last ${count} ${unit}`
}

/**
 * Escape a cell value so it cannot break a Markdown table: backslashes first,
 * then pipes, then newlines (rendered as a literal `\n`).
 */
function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "\\n")
}

/**
 * RFC 4180 quoting: wrap the field in double quotes when it contains a comma,
 * double quote, or newline; double any embedded double quotes. Fields without
 * those characters (including all raw numbers) pass through unchanged.
 */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

// ─── Builders ────────────────────────────────────────────────────────────────

/**
 * Serialize `data` to a Markdown table with a leading metadata line, one row
 * per `ExportRow`, and a bold totals row. Empty `rows` still produce the
 * metadata line, header, separator, and a zeroed totals row.
 */
export function buildMarkdown(data: ExportData): string {
  const statsSuffix = formatStatsSuffix(data.periodStats)
  const lines: string[] = [
    `## Usage · ${data.period.start} → ${data.period.end} (${data.period.granularity}) · sorted by ${data.sortMode}${statsSuffix}`,
    "",
    "| Provider | Model | Input | Output | Total tokens | Share % | Cost | Cost/1M |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ]
  for (const row of data.rows) {
    lines.push(
      `| ${escapeMarkdownCell(row.provider)} | ${escapeMarkdownCell(row.model)} | ` +
        `${formatThousands(row.input)} | ${formatThousands(row.output)} | ` +
        `${formatThousands(row.totalTokens)} | ${round2(row.sharePct)}% | ` +
        `$${round2(row.cost).toFixed(2)} | ${formatCostPerMillion(row.costPerMillion)} |`
    )
  }
  lines.push(
    `|  | **Total** | ${formatThousands(data.totalInput)} | ${formatThousands(data.totalOutput)} | ` +
      `${formatThousands(data.totalTokens)} | 100% | $${round2(data.totalCost).toFixed(2)} |  |`
  )
  if (data.projection) {
    lines.push("")
    lines.push(
      `On pace: $${round2(data.projection.projectedCost).toFixed(2)} by end of month`
    )
  }
  if (data.trends) {
    lines.push("")
    lines.push(`## Trends · ${trendsWindowDesc(data.period.granularity, data.trends.values.length)}`)
    lines.push("")
    lines.push("| Period | Tokens |")
    lines.push("| --- | ---: |")
    for (let i = 0; i < data.trends.labels.length; i++) {
      lines.push(
        `| ${escapeMarkdownCell(data.trends.labels[i])} | ${formatThousands(data.trends.values[i])} |`
      )
    }
    if (data.trends.peakWeekday) {
      lines.push("")
      lines.push(`Most used on: ${data.trends.peakWeekday}`)
    }
  }
  return lines.join("\n")
}

/**
 * Serialize `data` to CSV (RFC 4180 quoting). `sharePct` is rounded to two
 * decimals; `cost` is rounded to two decimals and emitted with two decimals;
 * `cost_per_1m` is empty (null), `0` (free), or a two-decimal CPM; the
 * `projected_cost` column is only filled on the totals row. A `TOTAL` row
 * always follows the data rows (zeroed when `rows` is empty).
 */
export function buildCsv(data: ExportData): string {
  const lines: string[] = [
    "period_start,period_end,provider,model,input,output,total_tokens,share_pct,sort_mode,cost,cost_per_1m,projected_cost,sessions,messages,peak_weekday",
  ]
  for (const row of data.rows) {
    const costPerMillion =
      row.costPerMillion === null
        ? ""
        : row.costPerMillion === 0
          ? "0"
          : round2(row.costPerMillion).toFixed(2)
    lines.push(
      [
        csvField(data.period.start),
        csvField(data.period.end),
        csvField(row.provider),
        csvField(row.model),
        String(row.input),
        String(row.output),
        String(row.totalTokens),
        String(round2(row.sharePct)),
        data.sortMode,
        round2(row.cost).toFixed(2),
        costPerMillion,
        "",
        "",
        "",
        "",
      ].join(",")
    )
  }
  const projectedCost = data.projection
    ? round2(data.projection.projectedCost).toFixed(2)
    : ""
  const statsCells = data.periodStats
    ? [String(data.periodStats.sessions), String(data.periodStats.messages)]
    : ["", ""]
  lines.push(
    [
      csvField(data.period.start),
      csvField(data.period.end),
      "",
      "TOTAL",
      String(data.totalInput),
      String(data.totalOutput),
      String(data.totalTokens),
      "100",
      data.sortMode,
      round2(data.totalCost).toFixed(2),
      "",
      projectedCost,
      ...statsCells,
      data.trends?.peakWeekday ?? "",
    ].join(",")
  )
  return lines.join("\n")
}

/**
 * Serialize `data` to pretty-printed JSON (2-space indent). `cost`, `sharePct`,
 * and `costPerMillion` are rounded to two decimals; `projection` is `null` when
 * absent. Empty `rows` yield `models: []` with `totals` still present.
 */
export function buildJson(data: ExportData): string {
  return JSON.stringify(
    {
      period: {
        start: data.period.start,
        end: data.period.end,
        granularity: data.period.granularity,
      },
      sortMode: data.sortMode,
      totals: {
        input: data.totalInput,
        output: data.totalOutput,
        tokens: data.totalTokens,
        cost: round2(data.totalCost),
      },
      projection: data.projection
        ? {
            projectedCost: round2(data.projection.projectedCost),
            elapsedDays: data.projection.elapsedDays,
            totalDays: data.projection.totalDays,
          }
        : null,
      periodStats: data.periodStats
        ? {
            sessions: data.periodStats.sessions,
            messages: data.periodStats.messages,
          }
        : null,
      trends: data.trends
        ? {
            values: data.trends.values,
            labels: data.trends.labels,
            peakWeekday: data.trends.peakWeekday,
          }
        : null,
      models: data.rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        input: row.input,
        output: row.output,
        totalTokens: row.totalTokens,
        sharePct: round2(row.sharePct),
        cost: round2(row.cost),
        costPerMillion:
          row.costPerMillion === null ? null : round2(row.costPerMillion),
      })),
    },
    null,
    2
  )
}

/**
 * Serialize `data` to a human-readable plain-text dump (no Markdown syntax).
 * Empty `rows` yield header + totals only.
 */
export function buildText(data: ExportData): string {
  const statsSuffix = formatStatsSuffix(data.periodStats)
  const lines: string[] = [
    `Usage · ${data.period.start} → ${data.period.end} (${data.period.granularity}) · sorted by ${data.sortMode}${statsSuffix}`,
    `Total: ${formatThousands(data.totalTokens)} tokens · $${round2(data.totalCost).toFixed(2)}`,
    `↑ Input  ${formatThousands(data.totalInput)}`,
    `↓ Output ${formatThousands(data.totalOutput)}`,
  ]
  for (const row of data.rows) {
    const suffix =
      row.costPerMillion === null
        ? ""
        : row.costPerMillion === 0
          ? " · free"
          : ` · $${round2(row.costPerMillion).toFixed(2)}/1M`
    lines.push(
      `${row.provider}/${row.model} — ${formatThousands(row.totalTokens)} tokens · ` +
        `${round2(row.sharePct)}% · $${round2(row.cost).toFixed(2)}${suffix}`
    )
  }
  if (data.projection) {
    lines.push(`On pace: $${round2(data.projection.projectedCost).toFixed(2)} by end of month`)
  }
  if (data.trends) {
    lines.push("")
    lines.push(`Trends · ${trendsWindowDesc(data.period.granularity, data.trends.values.length)}`)
    for (let i = 0; i < data.trends.labels.length; i++) {
      lines.push(
        `${data.trends.labels[i]}  ${formatThousands(data.trends.values[i])}`
      )
    }
    if (data.trends.peakWeekday) {
      lines.push("")
      lines.push(`Most used on: ${data.trends.peakWeekday}`)
    }
  }
  return lines.join("\n")
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Dispatch to the builder matching `format` and return its serialized output.
 */
export function buildExport(format: ExportFormat, data: ExportData): string {
  switch (format) {
    case "markdown":
      return buildMarkdown(data)
    case "csv":
      return buildCsv(data)
    case "json":
      return buildJson(data)
    case "text":
      return buildText(data)
    default:
      throw new Error(`Unknown export format: ${String(format)}`)
  }
}

// ─── Assembler ───────────────────────────────────────────────────────────────

/**
 * Pure, testable builder that assembles an `ExportData` from the live usage
 * summary. Extracted so the export wiring in usage.tsx stays thin and the
 * shape (including the totals fields consumed by the wlib builders) is
 * guaranteed, not assembled ad hoc.
 *
 * NOTE: the export's share % mirrors the dialog's on-screen share, which is
 * sort-mode-dependent: cost share when sorting by cost/price, token share
 * otherwise. Passing the current `sortKey` keeps the exported percentages
 * consistent with what the dialog displays.
 */
export interface BuildExportDataOptions {
  usage: UsageData
  sortedModels: ModelUsage[]
  period: ExportPeriod
  sortKey: ModelSortKey
  projection: ExportProjection | null
  periodStats: ExportPeriodStats | null
  trends: ExportTrends | null
}

export function buildExportData(options: BuildExportDataOptions): ExportData {
  const { usage, sortedModels, period, sortKey, projection, periodStats, trends } = options
  const moneySort = sortKey === "cost" || sortKey === "price"

  // grandTotal == the dialog's totalTokens (input + output across all usage)
  const grandTotal = usage.totalInput + usage.totalOutput

  // shareTotal comes from the UsageData totals (the DB ground truth), NOT the
  // sum of the model rows. If rows are truncated/partial, per-row percentages
  // may not sum to exactly 100%.
  const shareTotal = moneySort ? usage.totalCost : grandTotal

  const rows: ExportRow[] = sortedModels.map((m) => {
    const totalTokens = m.totalInput + m.totalOutput
    const shareValue = moneySort ? m.totalCost : totalTokens
    return {
      provider: m.providerID,
      model: m.modelID,
      input: m.totalInput,
      output: m.totalOutput,
      totalTokens,
      sharePct: shareTotal > 0 ? (shareValue / shareTotal) * 100 : 0,
      cost: m.totalCost,
      costPerMillion: costPerMillion(m),
    }
  })

  return {
    period,
    rows,
    totalInput: usage.totalInput,
    totalOutput: usage.totalOutput,
    totalTokens: grandTotal,
    totalCost: usage.totalCost,
    sortMode: sortKey,
    projection,
    periodStats,
    trends,
  }
}