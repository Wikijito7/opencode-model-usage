import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import * as fs from "node:fs"
import {
  CACHE_VERSION,
  migrateV2Cache,
  migrateV3Cache,
  getCachedEarliestTs,
  setCachedEarliestTs,
  flushDiskSave,
} from "@model-usage/cache"

// ─── Suite 1: migrateV3Cache ─────────────────────────────────────────────────

describe("migrateV3Cache", () => {
  it("returns version === CACHE_VERSION (4)", () => {
    const result = migrateV3Cache({ months: {} })
    expect(result.version).toBe(CACHE_VERSION)
  })

  it("returns earliestTs === null", () => {
    const result = migrateV3Cache({ months: {} })
    expect(result.earliestTs).toBeNull()
  })

  it("preserves months as a deep clone (mutating result does not mutate input)", () => {
    const input = {
      months: {
        "123": {
          inputTokens: 100,
          outputTokens: 50,
          models: [{ providerID: "openai", modelID: "gpt-4" }],
        },
      },
    }
    const result = migrateV3Cache(input)

    expect(result.months).toEqual(input.months)

    // Mutate the returned object deeply.
    result.months["123"].inputTokens = 999
    result.months["123"].models![0].modelID = "mutated"

    // Input must be untouched.
    expect(input.months["123"].inputTokens).toBe(100)
    expect(input.months["123"].models![0].modelID).toBe("gpt-4")
  })

  it("handles missing months (undefined) → months === {}", () => {
    const result = migrateV3Cache({ version: 3 })
    expect(result.months).toEqual({})
  })

  it("handles empty months object → months === {}", () => {
    const result = migrateV3Cache({ months: {} })
    expect(result.months).toEqual({})
  })
})

// ─── Suite 2: migrateV2Cache (v4 shape) ─────────────────────────────────────

describe("migrateV2Cache v4 shape", () => {
  it("normalizes providerId/modelId → providerID/modelID", () => {
    const input = {
      months: {
        "123": {
          models: [{ providerId: "openai", modelId: "gpt-4", totalCost: 0.1 }],
        },
      },
    }
    const result = migrateV2Cache(input)
    const model = result.months["123"].models![0]
    expect(model.providerID).toBe("openai")
    expect(model.modelID).toBe("gpt-4")
    expect((model as any).providerId).toBeUndefined()
    expect((model as any).modelId).toBeUndefined()
  })

  it("normalizes nested week/day models", () => {
    const input = {
      months: {
        "123": {
          weeks: [
            {
              days: [
                { models: [{ providerId: "meta", modelId: "llama" }] },
              ],
            },
          ],
        },
      },
    }
    const result = migrateV2Cache(input)
    const model = result.months["123"].weeks![0].days![0].models![0]
    expect(model.providerID).toBe("meta")
    expect(model.modelID).toBe("llama")
    expect((model as any).providerId).toBeUndefined()
    expect((model as any).modelId).toBeUndefined()
  })

  it("returns version === CACHE_VERSION (4)", () => {
    const result = migrateV2Cache({ months: {} })
    expect(result.version).toBe(CACHE_VERSION)
  })

  it("returns earliestTs === null", () => {
    const result = migrateV2Cache({ months: {} })
    expect(result.earliestTs).toBeNull()
  })
})

// ─── Suite 3: getCachedEarliestTs / setCachedEarliestTs ─────────────────────

describe("getCachedEarliestTs / setCachedEarliestTs", () => {
  beforeEach(() => {
    // Known starting value; clears any state persisted by a prior test run.
    setCachedEarliestTs(null)
    flushDiskSave()
  })

  afterEach(() => {
    // Clear any pending debounce timer and reset shared state to avoid
    // leaking timers/state between tests.
    flushDiskSave()
    setCachedEarliestTs(null)
    flushDiskSave()
  })

  it("returns null by default", () => {
    expect(getCachedEarliestTs()).toBeNull()
  })

  it("round-trips a value set via setCachedEarliestTs", () => {
    setCachedEarliestTs(123456)
    expect(getCachedEarliestTs()).toBe(123456)
  })

  it("setCachedEarliestTs(null) clears to null", () => {
    setCachedEarliestTs(987654)
    setCachedEarliestTs(null)
    expect(getCachedEarliestTs()).toBeNull()
  })

  it("setCachedEarliestTs triggers a disk save after flushDiskSave", () => {
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(() => 42 as any)
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {})

    setCachedEarliestTs(123456)
    expect(writeSpy).toHaveBeenCalledTimes(0)

    flushDiskSave()
    expect(writeSpy).toHaveBeenCalledTimes(1)

    setTimeoutSpy.mockRestore()
    writeSpy.mockRestore()
  })
})
