import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import * as fs from "node:fs"
import {
  CACHE_VERSION,
  migrateV2Cache,
  migrateV3Cache,
  migrateV4Cache,
  getCachedEarliestTs,
  setCachedEarliestTs,
  flushDiskSave,
  findNullCountMonths,
  type CachePeriod,
} from "@model-usage/cache"

// ─── Disk-write isolation ──────────────────────────────────────────────────────
// Mock writeFileSync for the whole file so no test ever touches the real
// `.usage-cache.json`. Any pending debounced save is flushed on teardown while
// the mock is still active (flushing after restore would write to disk).

let writeSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {})
  writeSpy.mockClear()
})

afterEach(() => {
  // Flush any pending debounced save while writeFileSync is still mocked.
  flushDiskSave()
  writeSpy.mockRestore()
})

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

// ─── Suite 3: migrateV4Cache ────────────────────────────────────────────────

describe("migrateV4Cache", () => {
  it("returns version === CACHE_VERSION (5)", () => {
    const result = migrateV4Cache({ months: {} })
    expect(result.version).toBe(CACHE_VERSION)
  })

  it("sets messageCount/sessionCount to null on a month-level period", () => {
    const input = {
      months: {
        "123": { inputTokens: 100, outputTokens: 50, messageCount: 10, sessionCount: 5 },
      },
    }
    const result = migrateV4Cache(input)
    expect(result.months["123"].messageCount).toBeNull()
    expect(result.months["123"].sessionCount).toBeNull()
  })

  it("sets messageCount/sessionCount to null on nested week and day periods", () => {
    const input = {
      months: {
        "1": {
          weeks: [
            {
              messageCount: 7,
              sessionCount: 3,
              days: [{ messageCount: 2, sessionCount: 1 }],
            },
          ],
          days: [{ messageCount: 4, sessionCount: 2 }],
        },
      },
    }
    const result = migrateV4Cache(input)

    expect(result.months["1"].weeks![0].messageCount).toBeNull()
    expect(result.months["1"].weeks![0].sessionCount).toBeNull()
    expect(result.months["1"].weeks![0].days![0].messageCount).toBeNull()
    expect(result.months["1"].weeks![0].days![0].sessionCount).toBeNull()
    expect(result.months["1"].days![0].messageCount).toBeNull()
    expect(result.months["1"].days![0].sessionCount).toBeNull()
  })

  it("preserves existing fields (inputTokens, totalCost, models) on the cloned result", () => {
    const input = {
      months: {
        "123": {
          inputTokens: 100,
          outputTokens: 50,
          totalCost: 1.25,
          messageCount: 10,
          sessionCount: 5,
          models: [{ providerID: "openai", modelID: "gpt-4", totalCost: 1.25 }],
          weeks: [
            {
              inputTokens: 60,
              totalCost: 0.75,
              messageCount: 6,
              sessionCount: 3,
              days: [{ inputTokens: 20, totalCost: 0.25, messageCount: 2, sessionCount: 1 }],
            },
          ],
        },
      },
    }
    const result = migrateV4Cache(input)

    expect(result.months["123"].inputTokens).toBe(100)
    expect(result.months["123"].totalCost).toBe(1.25)
    expect(result.months["123"].models).toEqual([
      { providerID: "openai", modelID: "gpt-4", totalCost: 1.25 },
    ])
    expect(result.months["123"].weeks![0].inputTokens).toBe(60)
    expect(result.months["123"].weeks![0].totalCost).toBe(0.75)
    expect(result.months["123"].weeks![0].days![0].totalCost).toBe(0.25)
  })

  it("deep-clones (mutating the result does not mutate input)", () => {
    const input = {
      months: {
        "123": {
          inputTokens: 100,
          outputTokens: 50,
          messageCount: 10,
          sessionCount: 5,
          models: [{ providerID: "openai", modelID: "gpt-4" }],
        },
      },
    }
    const result = migrateV4Cache(input)

    // Migration sets messageCount/sessionCount to null but keeps the rest.
    expect(result.months["123"]).toEqual({
      ...input.months["123"],
      messageCount: null,
      sessionCount: null,
    })

    // Mutate the returned object deeply.
    result.months["123"].inputTokens = 999
    result.months["123"].models![0].modelID = "mutated"

    // Input must be untouched.
    expect(input.months["123"].inputTokens).toBe(100)
    expect(input.months["123"].messageCount).toBe(10)
    expect(input.months["123"].models![0].modelID).toBe("gpt-4")
  })

  it("handles missing months (undefined) → months === {}", () => {
    const result = migrateV4Cache({ version: 4, earliestTs: 123 })
    expect(result.months).toEqual({})
  })

  it("preserves earliestTs when it is a number, null otherwise", () => {
    const withTs = migrateV4Cache({ months: {}, earliestTs: 123456 })
    expect(withTs.earliestTs).toBe(123456)

    const withoutTs = migrateV4Cache({ months: {} })
    expect(withoutTs.earliestTs).toBeNull()

    const nullTs = migrateV4Cache({ months: {}, earliestTs: null })
    expect(nullTs.earliestTs).toBeNull()

    const nonNumberTs = migrateV4Cache({ months: {}, earliestTs: "bogus" })
    expect(nonNumberTs.earliestTs).toBeNull()
  })
})

// ─── Suite 4: getCachedEarliestTs / setCachedEarliestTs ─────────────────────

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

    // Reset call count (the suite's beforeEach may have triggered a flush).
    writeSpy.mockClear()
    setCachedEarliestTs(123456)
    expect(writeSpy).toHaveBeenCalledTimes(0)

    flushDiskSave()
    expect(writeSpy).toHaveBeenCalledTimes(1)

    setTimeoutSpy.mockRestore()
  })
})

// ─── Suite 5: findNullCountMonths ────────────────────────────────────────────

describe("findNullCountMonths", () => {
  /** Build a minimal, fully-populated CachePeriod fixture. */
  function makePeriod(overrides: Partial<CachePeriod> = {}): CachePeriod {
    return {
      startMs: 1_000_000,
      endMs: 2_000_000,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      messageCount: 100,
      sessionCount: 50,
      change: 0,
      lastUpdated: 0,
      weeks: null,
      days: null,
      models: null,
      ...overrides,
    }
  }

  it("returns months where sessionCount is null even if messageCount is set", () => {
    const months = {
      "2025-01": makePeriod({ startMs: 100, sessionCount: null, messageCount: 42 }),
      "2025-02": makePeriod({ startMs: 200, sessionCount: null, messageCount: 7 }),
      "2025-03": makePeriod({ startMs: 300, sessionCount: 10, messageCount: 20 }),
    }

    const result = findNullCountMonths(months)

    expect(result.map((m) => m.startMs)).toEqual([100, 200])
  })

  it("returns months where messageCount is null even if sessionCount is set", () => {
    const months = {
      "2025-01": makePeriod({ startMs: 100, messageCount: null, sessionCount: 3 }),
      "2025-02": makePeriod({ startMs: 200, messageCount: null, sessionCount: 9 }),
      "2025-03": makePeriod({ startMs: 300, messageCount: 5, sessionCount: 6 }),
    }

    const result = findNullCountMonths(months)

    expect(result.map((m) => m.startMs)).toEqual([100, 200])
  })

  it("skips months where both counts are populated", () => {
    const months = {
      "2025-01": makePeriod({ startMs: 100, messageCount: 10, sessionCount: 2 }),
      "2025-02": makePeriod({ startMs: 200, messageCount: 0, sessionCount: 0 }),
      "2025-03": makePeriod({ startMs: 300, messageCount: 15, sessionCount: 4 }),
    }

    const result = findNullCountMonths(months)

    expect(result).toEqual([])
  })

  it("returns [] for an empty record", () => {
    expect(findNullCountMonths({})).toEqual([])
  })

  it("returns [] when all months are complete", () => {
    const months = {
      "2025-01": makePeriod({ startMs: 100, messageCount: 10, sessionCount: 2 }),
      "2025-02": makePeriod({ startMs: 200, messageCount: 8, sessionCount: 1 }),
      "2025-03": makePeriod({ startMs: 300, messageCount: 0, sessionCount: 0 }),
    }

    expect(findNullCountMonths(months)).toEqual([])
  })

  it("returns a month where BOTH sessionCount and messageCount are null", () => {
    const months = {
      "2025-01": makePeriod({ startMs: 100, sessionCount: null, messageCount: null }),
    }

    const result = findNullCountMonths(months)

    expect(result.map((m) => m.startMs)).toEqual([100])
  })

  it("returns months where sessionCount and/or messageCount is undefined", () => {
    const months = {
      "2025-01": makePeriod({ startMs: 100, sessionCount: undefined }),
      "2025-02": makePeriod({ startMs: 200, messageCount: undefined }),
      "2025-03": makePeriod({ startMs: 300, sessionCount: undefined, messageCount: undefined }),
      "2025-04": makePeriod({ startMs: 400, messageCount: 10, sessionCount: 2 }),
    }

    const result = findNullCountMonths(months)

    expect(result.map((m) => m.startMs)).toEqual([100, 200, 300])
  })

  it("does not mutate the input months record", () => {
    const months = {
      "2025-01": makePeriod({ startMs: 100, sessionCount: null, messageCount: 42 }),
      "2025-02": makePeriod({ startMs: 200, messageCount: null, sessionCount: 3 }),
      "2025-03": makePeriod({ startMs: 300, messageCount: 10, sessionCount: 2 }),
    }
    const keyCount = Object.keys(months).length
    const before = JSON.parse(JSON.stringify(months)) as Record<string, CachePeriod>

    findNullCountMonths(months)

    expect(Object.keys(months).length).toBe(keyCount)
    expect(months).toEqual(before)
  })
})
