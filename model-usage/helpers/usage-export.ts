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

import type { UsageData, ModelUsage } from "../types"
import type { ExportData, ExportRow, ExportPeriod, ExportProjection, ExportPeriodStats, ExportTrends } from "../wlib/export"
import type { ModelSortKey } from "./models"
import { costPerMillion } from "./models"

export function buildExportData(
  usage: UsageData,
  sortedModels: ModelUsage[],
  period: ExportPeriod,
  sortKey: ModelSortKey,
  projection: ExportProjection | null,
  periodStats: ExportPeriodStats | null,
  trends: ExportTrends | null,
): ExportData {
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
