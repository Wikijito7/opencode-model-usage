/**
 * model-usage — v2 sidebar domain (pure).
 *
 * Aggregates per-session token/cost tallies from the legacy-mapped message
 * list (`message-adapter.toLegacyMessages`) so the v2 sidebar reads the v2 data
 * API reactively while the maths stays testable and host-free.
 *
 * Semantics mirror the v1 sidebar:
 * - `peakInputTokens` = max per-call (input + cache read): the cache read is the
 *   full cached context re-sent every call, so summing it inflates the count.
 * - `outputTokens` = sum of assistant output tokens.
 * - `cacheRead` / `nonCachedInput` feed the cache-hit-rate line.
 * - cost is split price-weighted using the v2 `ModelInfo.cost` tiers, falling
 *   back to a token-proportional split when no pricing is found.
 */

import type { LegacyMessage } from "./message-adapter"
import {
  getUsageColor,
  getProjectionColor,
  type UsageStatusColors,
} from "../helpers/format"

// ─── Quota status theme colors (pure) ─────────────────────────────────────────
//
// Maps a quota percentage to a semantic theme token so the v2 sidebar follows
// the active theme instead of hardcoding hex values. The threshold logic lives
// in the shared `helpers/format.ts` color helpers (strict `>`): healthy ≤75,
// warning >75 through 90, danger >90.
//
// Colors are `ThemeColorValue`s (`string | RGBA`) and are always passed through
// untouched — never string-coerced — so the host's RGBA objects survive.

export type { UsageStatusColors }
export { USAGE_WARNING_THRESHOLD, USAGE_DANGER_THRESHOLD } from "../helpers/format"

/**
 * Map a usage percentage to its semantic status token.
 *
 * Mirrors `helpers/format.ts:getUsageColor`'s strict thresholds:
 * `>90` red, `>75` warning, otherwise success.
 */
export const getUsageThemeColor = getUsageColor

/**
 * Map a projected month-end percentage to a semantic status token.
 *
 * Mirrors the v1 projection line: success while the projection stays within
 * the quota (≤100), red when it overshoots it.
 */
export const getProjectionThemeColor = getProjectionColor

/** Structural view of a v2 `ModelInfo` (only pricing is consumed). */
export interface ModelLike {
  providerID?: string
  modelID?: string
  id?: string
  cost?: ReadonlyArray<{
    input: number
    output: number
    cache?: { read?: number; write?: number }
  }>
}

export interface PricingEntry {
  providerID?: string
  modelID: string
  input: number
  output: number
  cacheRead: number
}

export interface SidebarTotals {
  peakInputTokens: number
  outputTokens: number
  cacheRead: number
  nonCachedInput: number
  inputCost: number
  outputCost: number
}

export const EMPTY_SIDEBAR_TOTALS: SidebarTotals = {
  peakInputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  nonCachedInput: 0,
  inputCost: 0,
  outputCost: 0,
}

/**
 * Flatten v2 model definitions into a price lookup keyed by provider+model id.
 * Uses the first cost tier (mirrors the v1 sidebar, which read `model.cost`).
 */
export function toPricing(models: readonly ModelLike[] | undefined): PricingEntry[] {
  const out: PricingEntry[] = []
  for (const m of models ?? []) {
    const modelID = m.modelID ?? m.id
    if (!modelID) continue
    const tier = m.cost?.[0]
    if (!tier) continue
    out.push({
      providerID: m.providerID,
      modelID,
      input: tier.input ?? 0,
      output: tier.output ?? 0,
      cacheRead: tier.cache?.read ?? 0,
    })
  }
  return out
}

/**
 * Resolve a pricing entry for a model.
 *
 * Identity is provider **plus** model id where the data supports it: two
 * providers can expose the same model id (e.g. `claude`) at different prices,
 * so an exact provider+model match wins. When the caller has no provider, or no
 * exact match exists, fall back to the previous model-id-only lookup so
 * existing behaviour is preserved.
 */
function findPricing(
  pricing: readonly PricingEntry[],
  modelID: string | undefined,
  providerID: string | undefined,
): PricingEntry | undefined {
  if (!modelID) return undefined
  if (providerID !== undefined) {
    const exact = pricing.find((p) => p.modelID === modelID && p.providerID === providerID)
    if (exact) return exact
  }
  return pricing.find((p) => p.modelID === modelID)
}

/** Price-weighted input/output split; token-proportional when unpriced. */
export function splitAssistantCost(
  deltaInput: number,
  deltaCacheRead: number,
  deltaOutput: number,
  deltaCost: number,
  modelID: string | undefined,
  pricing: readonly PricingEntry[],
  providerID?: string,
): { inputCost: number; outputCost: number } {
  const entry = findPricing(pricing, modelID, providerID)
  const inputPrice = entry?.input ?? 0
  const outputPrice = entry?.output ?? 0
  const cacheReadPrice = entry?.cacheRead ?? 0

  // Fall back to a token-proportional split only when the tier carries no
  // pricing at all. A zero input/output price with a non-zero cache-read price
  // (cache-read-only tier) is still pricing and must flow through the
  // price-weighted split so its share is not silently ignored.
  if (inputPrice === 0 && outputPrice === 0 && cacheReadPrice === 0) {
    const totalTok = deltaInput + deltaCacheRead + deltaOutput
    if (totalTok === 0) return { inputCost: 0, outputCost: 0 }
    return {
      inputCost: (deltaCost * (deltaInput + deltaCacheRead)) / totalTok,
      outputCost: (deltaCost * deltaOutput) / totalTok,
    }
  }

  const inputWeight = (deltaInput * inputPrice + deltaCacheRead * cacheReadPrice) / 1_000_000
  const outputWeight = (deltaOutput * outputPrice) / 1_000_000
  const totalWeight = inputWeight + outputWeight
  if (totalWeight === 0) return { inputCost: 0, outputCost: 0 }

  return {
    inputCost: (deltaCost * inputWeight) / totalWeight,
    outputCost: (deltaCost * outputWeight) / totalWeight,
  }
}

/** Aggregate one session's assistant telemetry into sidebar totals. */
export function computeSidebarTotals(
  messages: readonly LegacyMessage[],
  pricing: readonly PricingEntry[],
): SidebarTotals {
  let peakInputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let nonCachedInput = 0
  let inputCost = 0
  let outputCost = 0

  for (const msg of messages) {
    const info = msg.info
    if (info.role !== "assistant") continue
    const tokens = info.tokens
    if (!tokens) continue
    const input = tokens.input ?? 0
    const read = tokens.cache?.read ?? 0
    const out = tokens.output ?? 0
    const cost = info.cost ?? 0

    const contextSize = input + read
    if (contextSize > peakInputTokens) peakInputTokens = contextSize

    outputTokens += out
    cacheRead += read
    nonCachedInput += input

    if (cost > 0) {
      const split = splitAssistantCost(input, read, out, cost, info.modelID, pricing, info.providerID)
      inputCost += split.inputCost
      outputCost += split.outputCost
    }
  }

  return { peakInputTokens, outputTokens, cacheRead, nonCachedInput, inputCost, outputCost }
}

/** Sum per-session totals (used across a root session's family). */
export function sumSidebarTotals(list: readonly SidebarTotals[]): SidebarTotals {
  return list.reduce<SidebarTotals>(
    (acc, t) => ({
      peakInputTokens: acc.peakInputTokens + t.peakInputTokens,
      outputTokens: acc.outputTokens + t.outputTokens,
      cacheRead: acc.cacheRead + t.cacheRead,
      nonCachedInput: acc.nonCachedInput + t.nonCachedInput,
      inputCost: acc.inputCost + t.inputCost,
      outputCost: acc.outputCost + t.outputCost,
    }),
    { ...EMPTY_SIDEBAR_TOTALS },
  )
}
