import { describe, it, expect } from "bun:test"
import {
  EMPTY_SIDEBAR_TOTALS,
  toPricing,
  splitAssistantCost,
  computeSidebarTotals,
  sumSidebarTotals,
  type PricingEntry,
  type SidebarTotals,
} from "@model-usage/v2/sidebar-domain"
import type { LegacyMessage } from "@model-usage/v2/message-adapter"

// ─── toPricing ───────────────────────────────────────────────────────────────

describe("toPricing", () => {
  it("returns an empty array for undefined or empty model lists", () => {
    expect(toPricing(undefined)).toEqual([])
    expect(toPricing([])).toEqual([])
  })

  it("maps the first cost tier into a pricing entry keyed by provider+model", () => {
    const pricing = toPricing([
      {
        providerID: "anthropic",
        modelID: "claude",
        cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      },
    ])
    expect(pricing).toEqual([
      { providerID: "anthropic", modelID: "claude", input: 3, output: 15, cacheRead: 0.3 },
    ])
  })

  it("falls back to the id field when modelID is absent", () => {
    const pricing = toPricing([{ id: "m2", cost: [{ input: 1, output: 2 }] }])
    expect(pricing).toEqual([{ providerID: undefined, modelID: "m2", input: 1, output: 2, cacheRead: 0 }])
  })

  it("prefers modelID over id when both are present", () => {
    const pricing = toPricing([{ modelID: "preferred", id: "fallback", cost: [{ input: 1, output: 1 }] }])
    expect(pricing[0].modelID).toBe("preferred")
  })

  it("skips models without an id and models without a cost tier", () => {
    const pricing = toPricing([
      { providerID: "p" },
      { providerID: "p", cost: [] },
      { providerID: "p", modelID: "ok", cost: [{ input: 1, output: 1 }] },
    ])
    expect(pricing).toHaveLength(1)
    expect(pricing[0].modelID).toBe("ok")
  })

  it("uses only the first tier and defaults missing tier fields to 0", () => {
    const pricing = toPricing([
      {
        modelID: "multi",
        cost: [
          { input: 1, output: 2, cache: { read: 0.1 } },
          { input: 9, output: 9, cache: { read: 9 } },
        ],
      },
      { modelID: "bare", cost: [{} as { input: number; output: number }] },
    ])
    expect(pricing[0]).toEqual({ providerID: undefined, modelID: "multi", input: 1, output: 2, cacheRead: 0.1 })
    expect(pricing[1]).toEqual({ providerID: undefined, modelID: "bare", input: 0, output: 0, cacheRead: 0 })
  })
})

// ─── splitAssistantCost ───────────────────────────────────────────────────────

describe("splitAssistantCost", () => {
  const emptyPricing: PricingEntry[] = []

  it("splits cost token-proportionally when no pricing is available", () => {
    const split = splitAssistantCost(100, 0, 100, 10, "m", emptyPricing)
    expect(split.inputCost).toBeCloseTo(5, 10)
    expect(split.outputCost).toBeCloseTo(5, 10)
  })

  it("counts cache-read tokens as part of the input share when unpriced", () => {
    const split = splitAssistantCost(50, 50, 100, 10, "m", emptyPricing)
    expect(split.inputCost).toBeCloseTo(5, 10)
    expect(split.outputCost).toBeCloseTo(5, 10)
  })

  it("returns zeros when unpriced and there are no tokens at all", () => {
    expect(splitAssistantCost(0, 0, 0, 10, "m", emptyPricing)).toEqual({ inputCost: 0, outputCost: 0 })
  })

  it("falls back to proportional split when the model id has no pricing entry", () => {
    const pricing: PricingEntry[] = [{ modelID: "other", input: 1, output: 1, cacheRead: 0 }]
    const split = splitAssistantCost(100, 0, 100, 10, "m", pricing)
    expect(split.inputCost).toBeCloseTo(5, 10)
    expect(split.outputCost).toBeCloseTo(5, 10)
  })

  it("flows through the price-weighted split for a cache-read-only tier", () => {
    const pricing: PricingEntry[] = [{ modelID: "m", input: 0, output: 0, cacheRead: 100 }]
    const split = splitAssistantCost(100, 100, 100, 9, "m", pricing)
    // A cache-read-only tier is still pricing (previous behaviour wrongly
    // treated it as unpriced). inputWeight = 100*100/1e6 = 0.01,
    // outputWeight = 0 → all cost on input, none on output.
    expect(split.inputCost).toBeCloseTo(9, 10)
    expect(split.outputCost).toBeCloseTo(0, 10)
  })

  it("falls back to proportional only when the tier is truly unpriced", () => {
    const pricing: PricingEntry[] = [{ modelID: "m", input: 0, output: 0, cacheRead: 0 }]
    const split = splitAssistantCost(100, 100, 100, 9, "m", pricing)
    // proportional over input+cacheRead+output = 300 → 2/3 * 9 = 6, 1/3 * 9 = 3
    expect(split.inputCost).toBeCloseTo(6, 10)
    expect(split.outputCost).toBeCloseTo(3, 10)
  })

  it("splits price-weighted when the model is priced", () => {
    const pricing: PricingEntry[] = [{ modelID: "m", input: 3, output: 15, cacheRead: 0.3 }]
    const split = splitAssistantCost(500_000, 1_000_000, 200_000, 10, "m", pricing)
    // inputWeight = (500000*3 + 1000000*0.3)/1e6 = 1.8
    // outputWeight = (200000*15)/1e6 = 3.0 ; total = 4.8
    expect(split.inputCost).toBeCloseTo(3.75, 10)
    expect(split.outputCost).toBeCloseTo(6.25, 10)
  })

  it("puts the whole cost on input when only input is priced and has weight", () => {
    const pricing: PricingEntry[] = [{ modelID: "m", input: 3, output: 0, cacheRead: 0 }]
    const split = splitAssistantCost(1_000_000, 0, 0, 6, "m", pricing)
    expect(split.inputCost).toBeCloseTo(6, 10)
    expect(split.outputCost).toBeCloseTo(0, 10)
  })

  it("returns zeros when priced but total weight is zero", () => {
    const pricing: PricingEntry[] = [{ modelID: "m", input: 3, output: 15, cacheRead: 0.3 }]
    expect(splitAssistantCost(0, 0, 0, 10, "m", pricing)).toEqual({ inputCost: 0, outputCost: 0 })
  })

  it("returns zeros when the model id is undefined and there are no tokens", () => {
    expect(splitAssistantCost(0, 0, 0, 0, undefined, emptyPricing)).toEqual({ inputCost: 0, outputCost: 0 })
  })

  // ─── provider + model identity ─────────────────────────────────────────────

  // Two providers expose the same model id at different prices. The exact
  // provider+model entry must win; a model-only lookup would silently use the
  // first entry for both.
  const sharedModelPricing: PricingEntry[] = [
    { providerID: "anthropic", modelID: "claude", input: 3, output: 15, cacheRead: 0.3 },
    { providerID: "openrouter", modelID: "claude", input: 2, output: 20, cacheRead: 0.2 },
  ]

  it("picks the exact provider+model pricing entry", () => {
    const anthropic = splitAssistantCost(500_000, 1_000_000, 200_000, 10, "claude", sharedModelPricing, "anthropic")
    expect(anthropic.inputCost).toBeCloseTo(3.75, 10)
    expect(anthropic.outputCost).toBeCloseTo(6.25, 10)

    const openrouter = splitAssistantCost(500_000, 1_000_000, 200_000, 10, "claude", sharedModelPricing, "openrouter")
    // inputWeight = (500000*2 + 1000000*0.2)/1e6 = 1.2 ; outputWeight = 4.0
    expect(openrouter.inputCost).toBeCloseTo((10 * 1.2) / 5.2, 10)
    expect(openrouter.outputCost).toBeCloseTo((10 * 4.0) / 5.2, 10)
  })

  it("distinguishes the same model id across providers", () => {
    const anthropic = splitAssistantCost(500_000, 1_000_000, 200_000, 10, "claude", sharedModelPricing, "anthropic")
    const openrouter = splitAssistantCost(500_000, 1_000_000, 200_000, 10, "claude", sharedModelPricing, "openrouter")
    expect(anthropic.inputCost).not.toBeCloseTo(openrouter.inputCost, 6)
    expect(anthropic.outputCost).not.toBeCloseTo(openrouter.outputCost, 6)
  })

  it("falls back to the first model-id match when the provider is unknown", () => {
    const split = splitAssistantCost(500_000, 1_000_000, 200_000, 10, "claude", sharedModelPricing, "nope")
    expect(split.inputCost).toBeCloseTo(3.75, 10)
    expect(split.outputCost).toBeCloseTo(6.25, 10)
  })

  it("uses model-id-only matching when no provider is supplied", () => {
    const split = splitAssistantCost(500_000, 1_000_000, 200_000, 10, "claude", sharedModelPricing)
    expect(split.inputCost).toBeCloseTo(3.75, 10)
    expect(split.outputCost).toBeCloseTo(6.25, 10)
  })

  it("falls back to a provider-less entry when the provider has no exact match", () => {
    const pricing: PricingEntry[] = [
      { modelID: "m", input: 1, output: 1, cacheRead: 0 },
      { providerID: "p", modelID: "m", input: 3, output: 15, cacheRead: 0.3 },
    ]
    const split = splitAssistantCost(500_000, 1_000_000, 200_000, 10, "m", pricing, "other")
    // no provider+model match → first model-id entry (input 1/output 1, cache 0)
    // inputWeight = 500000/1e6 = 0.5 ; outputWeight = 200000/1e6 = 0.2
    expect(split.inputCost).toBeCloseTo((10 * 0.5) / 0.7, 10)
    expect(split.outputCost).toBeCloseTo((10 * 0.2) / 0.7, 10)
  })
})

// ─── computeSidebarTotals ─────────────────────────────────────────────────────

/** Minimal legacy assistant message builder for sidebar aggregation. */
function assistant(
  tokens: { input?: number; output?: number; cache?: { read?: number; write?: number } },
  cost = 0,
  modelID = "m",
  providerID?: string,
): LegacyMessage {
  return {
    info: { role: "assistant", modelID, providerID, tokens, cost } as LegacyMessage["info"],
    parts: [],
  }
}

describe("computeSidebarTotals", () => {
  it("returns all zeros for an empty message list", () => {
    expect(computeSidebarTotals([], [])).toEqual(EMPTY_SIDEBAR_TOTALS)
  })

  it("ignores non-assistant messages", () => {
    const messages: LegacyMessage[] = [{ info: { role: "user" }, parts: [] }]
    expect(computeSidebarTotals(messages, [])).toEqual(EMPTY_SIDEBAR_TOTALS)
  })

  it("ignores assistant messages without tokens", () => {
    const messages: LegacyMessage[] = [{ info: { role: "assistant" }, parts: [] }]
    expect(computeSidebarTotals(messages, [])).toEqual(EMPTY_SIDEBAR_TOTALS)
  })

  it("computes peak input as max(input + cache.read) across calls", () => {
    const messages = [
      assistant({ input: 100, output: 50, cache: { read: 900, write: 0 } }),
      assistant({ input: 200, output: 80, cache: { read: 300, write: 0 } }),
      assistant({ input: 0, output: 5, cache: { read: 0, write: 0 } }),
    ]
    const totals = computeSidebarTotals(messages, [])
    expect(totals.peakInputTokens).toBe(1000)
    expect(totals.outputTokens).toBe(135)
    expect(totals.cacheRead).toBe(1200)
    expect(totals.nonCachedInput).toBe(300)
  })

  it("defaults missing token sub-fields to zero", () => {
    const totals = computeSidebarTotals([assistant({})], [])
    expect(totals.peakInputTokens).toBe(0)
    expect(totals.outputTokens).toBe(0)
    expect(totals.cacheRead).toBe(0)
    expect(totals.nonCachedInput).toBe(0)
  })

  it("distributes cost proportionally when no pricing is supplied", () => {
    const messages = [
      assistant({ input: 100, output: 50, cache: { read: 900, write: 0 } }, 10),
      assistant({ input: 200, output: 80, cache: { read: 300, write: 0 } }, 4),
    ]
    const totals = computeSidebarTotals(messages, [])
    expect(totals.inputCost).toBeCloseTo(10 * 1000 / 1050 + 4 * 500 / 580, 10)
    expect(totals.outputCost).toBeCloseTo(10 * 50 / 1050 + 4 * 80 / 580, 10)
  })

  it("does not contribute cost for assistant calls with zero cost", () => {
    const totals = computeSidebarTotals([assistant({ input: 100, output: 50 }, 0)], [])
    expect(totals.inputCost).toBe(0)
    expect(totals.outputCost).toBe(0)
    expect(totals.outputTokens).toBe(50)
  })

  it("uses supplied pricing for a price-weighted split per model", () => {
    const pricing: PricingEntry[] = [{ modelID: "m", input: 3, output: 15, cacheRead: 0.3 }]
    const totals = computeSidebarTotals(
      [assistant({ input: 500_000, output: 200_000, cache: { read: 1_000_000 } }, 10)],
      pricing,
    )
    expect(totals.inputCost).toBeCloseTo(3.75, 10)
    expect(totals.outputCost).toBeCloseTo(6.25, 10)
  })

  it("uses provider-specific pricing for the same model id", () => {
    const pricing: PricingEntry[] = [
      { providerID: "anthropic", modelID: "claude", input: 3, output: 15, cacheRead: 0.3 },
      { providerID: "openrouter", modelID: "claude", input: 2, output: 20, cacheRead: 0.2 },
    ]
    const tokens = { input: 500_000, output: 200_000, cache: { read: 1_000_000 } }
    const totals = computeSidebarTotals(
      [assistant(tokens, 10, "claude", "anthropic"), assistant(tokens, 10, "claude", "openrouter")],
      pricing,
    )
    expect(totals.inputCost).toBeCloseTo(3.75 + (10 * 1.2) / 5.2, 10)
    expect(totals.outputCost).toBeCloseTo(6.25 + (10 * 4.0) / 5.2, 10)
  })

  it("falls back to model-only pricing for a message without a provider", () => {
    const pricing: PricingEntry[] = [
      { providerID: "anthropic", modelID: "claude", input: 3, output: 15, cacheRead: 0.3 },
      { providerID: "openrouter", modelID: "claude", input: 2, output: 20, cacheRead: 0.2 },
    ]
    const totals = computeSidebarTotals(
      [assistant({ input: 500_000, output: 200_000, cache: { read: 1_000_000 } }, 10, "claude")],
      pricing,
    )
    expect(totals.inputCost).toBeCloseTo(3.75, 10)
    expect(totals.outputCost).toBeCloseTo(6.25, 10)
  })

  it("does not mutate the input messages or pricing", () => {
    const messages = [assistant({ input: 10, output: 5, cache: { read: 5, write: 0 } }, 1)]
    const pricing: PricingEntry[] = [{ modelID: "m", input: 1, output: 1, cacheRead: 1 }]
    const messagesBefore = JSON.parse(JSON.stringify(messages))
    const pricingBefore = JSON.parse(JSON.stringify(pricing))
    computeSidebarTotals(messages, pricing)
    expect(JSON.parse(JSON.stringify(messages))).toEqual(messagesBefore)
    expect(JSON.parse(JSON.stringify(pricing))).toEqual(pricingBefore)
  })
})

// ─── sumSidebarTotals ─────────────────────────────────────────────────────────

describe("sumSidebarTotals", () => {
  it("returns a zeroed copy for an empty list", () => {
    const summed = sumSidebarTotals([])
    expect(summed).toEqual(EMPTY_SIDEBAR_TOTALS)
    expect(summed).not.toBe(EMPTY_SIDEBAR_TOTALS)
  })

  it("sums every field across the given totals", () => {
    const a: SidebarTotals = {
      peakInputTokens: 1,
      outputTokens: 2,
      cacheRead: 3,
      nonCachedInput: 4,
      inputCost: 5,
      outputCost: 6,
    }
    const b: SidebarTotals = {
      peakInputTokens: 10,
      outputTokens: 20,
      cacheRead: 30,
      nonCachedInput: 40,
      inputCost: 50,
      outputCost: 60,
    }
    expect(sumSidebarTotals([a, b])).toEqual({
      peakInputTokens: 11,
      outputTokens: 22,
      cacheRead: 33,
      nonCachedInput: 44,
      inputCost: 55,
      outputCost: 66,
    })
  })

  it("does not mutate the input list or its entries", () => {
    const a: SidebarTotals = {
      peakInputTokens: 1,
      outputTokens: 2,
      cacheRead: 3,
      nonCachedInput: 4,
      inputCost: 5,
      outputCost: 6,
    }
    const snapshot = { ...a }
    sumSidebarTotals([a])
    expect(a).toEqual(snapshot)
  })

  it("handles a single entry as an identity", () => {
    const only: SidebarTotals = {
      peakInputTokens: 7,
      outputTokens: 8,
      cacheRead: 9,
      nonCachedInput: 10,
      inputCost: 11,
      outputCost: 12,
    }
    expect(sumSidebarTotals([only])).toEqual(only)
  })
})
