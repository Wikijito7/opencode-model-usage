/**
 * Session view helpers.
 * Pure functions for the top-sessions list so the sort toggle and scroll
 * clamp math are unit-testable without the TUI component harness.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionSortKey = "tokens" | "cost"

// ─── Sort toggle ─────────────────────────────────────────────────────────────

/**
 * Two-stop toggle used by the session view `o` key: tokens → cost → tokens.
 * Unlike the normal view's 3-stop cycle (tokens/cost/price), the session
 * view never sorts by price.
 */
export function toggleSessionSort(current: "tokens" | "cost"): "tokens" | "cost" {
  return current === "tokens" ? "cost" : "tokens"
}

// ─── Scroll clamp ────────────────────────────────────────────────────────────

/**
 * Clamp `scrollTop` into the valid scroll range for a scroll container.
 *
 * `scrollHeight` is the total scrollable height; `viewHeight` is the visible
 * viewport height. Any non-finite input (undefined/NaN) falls back to `0` so
 * the result is never NaN and never negative.
 */
export function clampScrollTop(scrollTop: number, scrollHeight: number, viewHeight: number): number {
  const st = Number.isFinite(scrollTop) ? scrollTop : 0
  const sh = Number.isFinite(scrollHeight) ? scrollHeight : 0
  const vh = Number.isFinite(viewHeight) ? viewHeight : 0
  const maxScroll = Math.max(0, sh - vh)
  return Math.max(0, Math.min(st, maxScroll))
}
