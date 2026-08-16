import { describe, expect, it } from "bun:test"
import { buildExportData } from "@model-usage/helpers/usage-export"
import type { ModelSortKey } from "@model-usage/helpers/models"
import type { ModelUsage, UsageData } from "@model-usage/types"
import type { ExportPeriod } from "@model-usage/wlib/export"

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PERIOD: ExportPeriod = {
  start: "2026-08-01",
  end: "2026-08-16",
  granularity: "month",
}

const TOKENS: ModelSortKey = "tokens"
const COST: ModelSortKey = "cost"
const PRICE: ModelSortKey = "price"

function makeModel(partial: Partial<ModelUsage>): ModelUsage {
  return {
    providerID: "provider",
    modelID: "model",
    totalCost: 0,
    totalInput: 0,
    totalOutput: 0,
    ...partial,
  }
}

function makeUsage(
  models: ModelUsage[],
  totalInput: number,
  totalOutput: number,
  totalCost: number,
): UsageData {
  return { models, totalInput, totalOutput, totalCost }
}

// ─── buildExportData ─────────────────────────────────────────────────────────

describe("buildExportData", () => {
  it("maps provider/model/input/output/totalTokens/cost for each model", () => {
    const models: ModelUsage[] = [
      makeModel({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        totalInput: 1200,
        totalOutput: 300,
        totalCost: 1.25,
      }),
      makeModel({
        providerID: "openai",
        modelID: "gpt-4o",
        totalInput: 500,
        totalOutput: 100,
        totalCost: 0.4,
      }),
    ]
    const usage = makeUsage(models, 1700, 400, 1.65)

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, null)

    expect(result.rows).toHaveLength(2)
    expect(result.sortMode).toBe("tokens")
    expect(result.rows[0]).toEqual({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      input: 1200,
      output: 300,
      totalTokens: 1500,
      sharePct: expect.any(Number),
      cost: 1.25,
      costPerMillion: expect.any(Number),
    })
    expect(result.rows[1]).toEqual({
      provider: "openai",
      model: "gpt-4o",
      input: 500,
      output: 100,
      totalTokens: 600,
      sharePct: expect.any(Number),
      cost: 0.4,
      costPerMillion: expect.any(Number),
    })
  })

  it("computes sharePct as the model's token share of the grand total (tokens sort)", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 1500, totalOutput: 500 }), // 2000 tokens
      makeModel({ totalInput: 800, totalOutput: 200 }), // 1000 tokens
    ]
    const usage = makeUsage(models, 2300, 700, 0)

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, null)

    expect(result.rows[0].totalTokens).toBe(2000)
    expect(result.rows[1].totalTokens).toBe(1000)
    expect(result.rows[0].sharePct).toBeCloseTo(66.67, 2)
    expect(result.rows[1].sharePct).toBeCloseTo(33.33, 2)
  })

  it("computes sharePct as the model's cost share of total cost (cost sort)", () => {
    const models: ModelUsage[] = [
      makeModel({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        totalInput: 1000,
        totalOutput: 500,
        totalCost: 3.0,
      }),
      makeModel({
        providerID: "openai",
        modelID: "gpt-4o",
        totalInput: 500,
        totalOutput: 100,
        totalCost: 1.0,
      }),
    ]
    const usage = makeUsage(models, 1500, 600, 4.0) // totalCost = 4.0

    const result = buildExportData(usage, models, PERIOD, COST, null, null, null)

    expect(result.rows).toHaveLength(2)
    expect(result.sortMode).toBe("cost")
    expect(result.rows[0].sharePct).toBeCloseTo((3.0 / 4.0) * 100, 2) // 75
    expect(result.rows[1].sharePct).toBeCloseTo((1.0 / 4.0) * 100, 2) // 25
  })

  it("computes sharePct as the model's cost share of total cost (price sort)", () => {
    const models: ModelUsage[] = [
      makeModel({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        totalInput: 1000,
        totalOutput: 500,
        totalCost: 3.0,
      }),
      makeModel({
        providerID: "openai",
        modelID: "gpt-4o",
        totalInput: 500,
        totalOutput: 100,
        totalCost: 1.0,
      }),
    ]
    const usage = makeUsage(models, 1500, 600, 4.0) // totalCost = 4.0

    const result = buildExportData(usage, models, PERIOD, PRICE, null, null, null)

    expect(result.rows).toHaveLength(2)
    expect(result.sortMode).toBe("price")
    expect(result.rows[0].sharePct).toBeCloseTo((3.0 / 4.0) * 100, 2)
    expect(result.rows[1].sharePct).toBeCloseTo((1.0 / 4.0) * 100, 2)
  })

  it("sets sortMode to the sort key for tokens, cost, and price sorting", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 1000, totalOutput: 500, totalCost: 3.0 }),
    ]
    const usage = makeUsage(models, 1000, 500, 3.0)

    expect(buildExportData(usage, models, PERIOD, TOKENS, null, null, null).sortMode).toBe("tokens")
    expect(buildExportData(usage, models, PERIOD, COST, null, null, null).sortMode).toBe("cost")
    expect(buildExportData(usage, models, PERIOD, PRICE, null, null, null).sortMode).toBe("price")
  })

  it("returns sharePct 0 (no NaN) for every row when total cost is zero in cost mode", () => {
    // Why this fixture looks contradictory: the model rows carry nonzero
    // totalCost (2.0 and 1.0) while usage.totalCost is 0. This is a deliberate,
    // valid defensive edge case. usage.totalCost is the ground-truth denominator
    // in cost mode, and this guards against a future refactor where the usage
    // totals and the model rows diverge (stale/partial data). In that situation
    // the function must not divide by zero or produce NaN — every row must still
    // yield sharePct 0.
    const models: ModelUsage[] = [
      makeModel({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        totalInput: 1000,
        totalOutput: 500,
        totalCost: 2.0,
      }),
      makeModel({
        providerID: "openai",
        modelID: "gpt-4o",
        totalInput: 500,
        totalOutput: 100,
        totalCost: 1.0,
      }),
    ]
    const usage = makeUsage(models, 1500, 600, 0) // totalCost = 0

    const result = buildExportData(usage, models, PERIOD, COST, null, null, null)

    expect(result.rows).toHaveLength(2)
    for (const row of result.rows) {
      expect(row.sharePct).toBe(0)
      expect(Number.isNaN(row.sharePct)).toBe(false)
    }
  })

  it("includes totals fields matching the input usage", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 2000, totalOutput: 500, totalCost: 2.0 }),
    ]
    const usage = makeUsage(models, 2000, 500, 2.0)

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, null)

    expect(result.sortMode).toBe("tokens")
    expect(result.totalInput).toBe(2000)
    expect(result.totalOutput).toBe(500)
    expect(result.totalTokens).toBe(2500)
    expect(result.totalCost).toBe(2.0)
  })

  it("returns an empty rows list for empty models but still populates totals", () => {
    const usage = makeUsage([], 0, 0, 0)

    const result = buildExportData(usage, [], PERIOD, TOKENS, null, null, null)

    expect(result.sortMode).toBe("tokens")
    expect(result.rows).toEqual([])
    expect(result.totalInput).toBe(0)
    expect(result.totalOutput).toBe(0)
    expect(result.totalTokens).toBe(0)
    expect(result.totalCost).toBe(0)
  })

  it("returns sharePct 0 for every row when the grand total is zero", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 0, totalOutput: 0 }),
      makeModel({ totalInput: 0, totalOutput: 0 }),
    ]
    const usage = makeUsage(models, 0, 0, 0)

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, null)

    expect(result.rows).toHaveLength(2)
    for (const row of result.rows) {
      expect(row.sharePct).toBe(0)
      expect(Number.isNaN(row.sharePct)).toBe(false)
    }
  })

  it("computes sharePct against the usage grand total, not the sum of model tokens", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 1500, totalOutput: 500 }), // 2000 tokens
      makeModel({ totalInput: 800, totalOutput: 200 }), // 1000 tokens
    ]
    // usage totals exceed the sum of the model rows (e.g. truncated/partial rows)
    const usage = makeUsage(models, 6000, 2000, 0) // grand total = 8000

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, null)

    const modelTokenSum = 2000 + 1000 // 3000, != grand total 8000
    expect(modelTokenSum).not.toBe(usage.totalInput + usage.totalOutput)
    expect(result.rows[0].sharePct).toBeCloseTo((2000 / 8000) * 100, 2)
    expect(result.rows[1].sharePct).toBeCloseTo((1000 / 8000) * 100, 2)
    // sums to < 100% because rows are partial relative to the grand total
    expect(result.rows[0].sharePct + result.rows[1].sharePct).toBeCloseTo(37.5, 2)
  })

  it("passes the period object through unchanged", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 100, totalOutput: 50 }),
    ]
    const usage = makeUsage(models, 100, 50, 0)

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, null)

    expect(result.period).toBe(PERIOD)
    expect(result.period).toEqual(PERIOD)
  })

  it("computes costPerMillion per row for paid, free, and zero-token models", () => {
    const models: ModelUsage[] = [
      // paid: 3 / (600 + 400) * 1_000_000 = 3000
      makeModel({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        totalInput: 600,
        totalOutput: 400,
        totalCost: 3,
      }),
      // free: cost 0 with tokens > 0 → 0
      makeModel({
        providerID: "openai",
        modelID: "gpt-4o-mini",
        totalInput: 1000,
        totalOutput: 500,
        totalCost: 0,
      }),
      // zero-token: no tokens at all → null
      makeModel({
        providerID: "meta",
        modelID: "llama-3",
        totalInput: 0,
        totalOutput: 0,
        totalCost: 0,
      }),
    ]
    const usage = makeUsage(models, 1600, 900, 3)

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, null)

    expect(result.rows).toHaveLength(3)
    expect(result.rows[0].costPerMillion).toBe(3000)
    expect(result.rows[1].costPerMillion).toBe(0)
    expect(result.rows[2].costPerMillion).toBeNull()
  })

  it("passes a non-null projection through unchanged", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 100, totalOutput: 50 }),
    ]
    const usage = makeUsage(models, 100, 50, 0)
    const projection = {
      projectedCost: 12.5,
      elapsedDays: 5,
      totalDays: 16,
    }

    const result = buildExportData(usage, models, PERIOD, TOKENS, projection, null, null)

    expect(result.projection).toEqual(projection)
  })

  it("sets projection to null when null is passed", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 100, totalOutput: 50 }),
    ]
    const usage = makeUsage(models, 100, 50, 0)

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, null)

    expect(result.projection).toBeNull()
  })

  it("passes a non-null periodStats object through unchanged", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 100, totalOutput: 50 }),
    ]
    const usage = makeUsage(models, 100, 50, 0)
    const periodStats = {
      sessions: 42,
      messages: 1337,
    }

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, periodStats, null)

    expect(result.periodStats).toEqual(periodStats)
  })

  it("sets periodStats to null when null is passed", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 100, totalOutput: 50 }),
    ]
    const usage = makeUsage(models, 100, 50, 0)

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, null)

    expect(result.periodStats).toBeNull()
  })

  it("passes a non-null trends object through unchanged", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 100, totalOutput: 50 }),
    ]
    const usage = makeUsage(models, 100, 50, 0)
    const trends = {
      values: [10, 20, 30, 40],
      labels: ["2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"],
      peakWeekday: "Wednesday",
    }

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, trends)

    expect(result.trends).toEqual(trends)
  })

  it("sets trends to null when null is passed", () => {
    const models: ModelUsage[] = [
      makeModel({ totalInput: 100, totalOutput: 50 }),
    ]
    const usage = makeUsage(models, 100, 50, 0)

    const result = buildExportData(usage, models, PERIOD, TOKENS, null, null, null)

    expect(result.trends).toBeNull()
  })
})
