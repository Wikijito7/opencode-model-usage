export interface BurnRateProjection {
  projected: number
  pct: number
}

// Minimum elapsed days before a projection is shown (days 1–2 show a placeholder instead)
export const MIN_ELAPSED_DAYS = 3

/**
 * Projects total usage by the end of a period from the usage accumulated so far.
 *
 * - Returns `null` when `elapsedDays <= 0` or `totalDays <= 0` (division-by-zero guard).
 * - `projected = used / elapsedDays * totalDays`, clamped to a lower bound of 0
 *   (negative `used` collapses to 0). No upper clamp — overshoot (>100%) shows through.
 * - `pct` is identical to `projected`; it represents a percentage when `used`
 *   is already a percentage.
 */
export function projectBurnRate(
  used: number,
  elapsedDays: number,
  totalDays: number,
): BurnRateProjection | null {
  if (!Number.isFinite(used) || !Number.isFinite(elapsedDays) || !Number.isFinite(totalDays)) return null
  if (elapsedDays <= 0 || totalDays <= 0) return null
  const projected = Math.max(0, (used / elapsedDays) * totalDays)
  return { projected, pct: projected }
}

export type ProjectionState =
  | { kind: "none" }
  | { kind: "calculating"; daysLeft: number }
  | { kind: "projected"; projection: { projectedCost: number; elapsedDays: number; totalDays: number } }

/**
 * Pure projection resolver: given the current-month cost and the elapsed/total
 * day counts, return whether a projection is unavailable ("none"), still
 * warming up ("calculating"), or ready ("projected").
 */
export function resolveProjection(
  totalCost: number,
  isCurrentMonth: boolean,
  elapsedDays: number,
  totalDays: number,
): ProjectionState {
  if (!isCurrentMonth || totalCost <= 0) return { kind: "none" }
  if (elapsedDays < MIN_ELAPSED_DAYS) return { kind: "calculating", daysLeft: MIN_ELAPSED_DAYS - elapsedDays }
  const proj = projectBurnRate(totalCost, elapsedDays, totalDays)
  return proj
    ? { kind: "projected", projection: { projectedCost: proj.projected, elapsedDays, totalDays } }
    : { kind: "none" }
}
