import { describe, expect, it } from "bun:test"
import { aggregateModelStats, costPerMillion, sortModels } from "@model-usage/helpers/models"
import type { ModelSortKey, ModelUsageRecord, ModelStat } from "@model-usage/helpers/models"
import { countModelSwitches, computeModelsTabLayout } from "@model-usage/helpers/model-tab"
import type { ModelUsage } from "@model-usage/types"

// ─── aggregateModelStats ─────────────────────────────────────────────────────

describe("aggregateModelStats", () => {
  it("returns empty array for empty input", () => {
    expect(aggregateModelStats([])).toEqual([])
  })

  it("handles a single record correctly", () => {
    const records: ModelUsageRecord[] = [
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 10,
        cost: 0.0015,
        visibleOutputTokens: 150,
        peakInputTokens: 150,
      },
    ]

    const result = aggregateModelStats(records)
    expect(result).toEqual([
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 1,
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 10,
        cost: 0.0015,
        visibleOutputTokens: 150,
        peakInputTokens: 150,
      },
    ])
  })

  it("correctly aggregates multiple records for the same provider/model pair", () => {
    const records: ModelUsageRecord[] = [
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 10,
        cost: 0.0015,
        visibleOutputTokens: 80,
        peakInputTokens: 150,
      },
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 200,
        outputTokens: 300,
        cacheRead: 20,
        cacheWrite: 0,
        cost: 0.002,
        visibleOutputTokens: 120,
        peakInputTokens: 220,
      },
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 50,
        outputTokens: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.0005,
        visibleOutputTokens: 30,
        peakInputTokens: 50,
      },
    ]

    const result = aggregateModelStats(records)
    expect(result).toEqual([
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 3,
        inputTokens: 350,
        outputTokens: 550,
        cacheRead: 70,
        cacheWrite: 10,
        cost: 0.004,
        visibleOutputTokens: 230,
        peakInputTokens: 220,
      },
    ])
  })

  it("correctly groups records with different providerID or modelID", () => {
    const records: ModelUsageRecord[] = [
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 10,
        cost: 0.0015,
        visibleOutputTokens: 150,
        peakInputTokens: 150,
      },
      {
        providerID: "openai",
        modelID: "gpt-4o",
        inputTokens: 300,
        outputTokens: 400,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.005,
        visibleOutputTokens: 250,
        peakInputTokens: 300,
      },
      {
        providerID: "openai",
        modelID: "gpt-4o-mini",
        inputTokens: 10,
        outputTokens: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.0001,
        visibleOutputTokens: 15,
        peakInputTokens: 10,
      },
    ]

    const result = aggregateModelStats(records)
    expect(result.length).toBe(3)

    const anthropicSonnet = result.find(r => r.providerID === "anthropic" && r.modelID === "claude-3-5-sonnet")
    const openaiGpt4o = result.find(r => r.providerID === "openai" && r.modelID === "gpt-4o")
    const openaiGpt4oMini = result.find(r => r.providerID === "openai" && r.modelID === "gpt-4o-mini")

    expect(anthropicSonnet).toEqual({
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet",
      msgCount: 1,
      inputTokens: 100,
      outputTokens: 200,
      cacheRead: 50,
      cacheWrite: 10,
      cost: 0.0015,
      visibleOutputTokens: 150,
      peakInputTokens: 150,
    })

    expect(openaiGpt4o).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
      msgCount: 1,
      inputTokens: 300,
      outputTokens: 400,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.005,
      visibleOutputTokens: 250,
      peakInputTokens: 300,
    })

    expect(openaiGpt4oMini).toEqual({
      providerID: "openai",
      modelID: "gpt-4o-mini",
      msgCount: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.0001,
      visibleOutputTokens: 15,
      peakInputTokens: 10,
    })
  })

  it("retains zero-value records without dropping them", () => {
    const records: ModelUsageRecord[] = [
      {
        providerID: "copilot",
        modelID: "free-model",
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        visibleOutputTokens: 0,
        peakInputTokens: 0,
      },
    ]

    const result = aggregateModelStats(records)
    expect(result).toEqual([
      {
        providerID: "copilot",
        modelID: "free-model",
        msgCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        visibleOutputTokens: 0,
        peakInputTokens: 0,
        lastCallRawPromptTokens: undefined,
      },
    ])
  })

  it("distinguishes same modelID with different providerID", () => {
    const records: ModelUsageRecord[] = [
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 10,
        cost: 0.0015,
        visibleOutputTokens: 120,
        peakInputTokens: 150,
      },
      {
        providerID: "openrouter",
        modelID: "claude-3-5-sonnet",
        inputTokens: 200,
        outputTokens: 400,
        cacheRead: 100,
        cacheWrite: 20,
        cost: 0.003,
        visibleOutputTokens: 240,
        peakInputTokens: 300,
      },
    ]

    const result = aggregateModelStats(records)
    expect(result.length).toBe(2)

    const anthropic = result.find(r => r.providerID === "anthropic")
    const openrouter = result.find(r => r.providerID === "openrouter")

    expect(anthropic?.msgCount).toBe(1)
    expect(anthropic?.inputTokens).toBe(100)
    expect(anthropic?.visibleOutputTokens).toBe(120)
    expect(openrouter?.msgCount).toBe(1)
    expect(openrouter?.inputTokens).toBe(200)
    expect(openrouter?.visibleOutputTokens).toBe(240)
  })

  describe("handling lastCallRawPromptTokens", () => {
    it("handles a single record correctly", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 25000,
          peakInputTokens: 150,
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0].lastCallRawPromptTokens).toBe(25000)
    })

    it("aggregates multiple records and asserts that lastCallRawPromptTokens equals the LAST record's value in array order", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 15000, // first
          peakInputTokens: 150,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          lastCallRawPromptTokens: 45000, // max, but not last
          peakInputTokens: 210,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 200,
          outputTokens: 300,
          cacheRead: 70,
          cacheWrite: 30,
          cost: 0.0025,
          visibleOutputTokens: 170,
          lastCallRawPromptTokens: 30000, // last (wins!)
          peakInputTokens: 270,
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0].lastCallRawPromptTokens).toBe(30000)
    })

    it("handles cases where lastCallRawPromptTokens is undefined / missing on some entries with sensible fallback behavior", () => {
      // Case A: First record is defined, second is undefined.
      // Expect lastCallRawPromptTokens to keep the most recently seen defined value.
      const recordsA: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 22000,
          peakInputTokens: 150,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          lastCallRawPromptTokens: undefined, // should not overwrite 22000 per implementation
          peakInputTokens: 210,
        },
      ]

      const resultA = aggregateModelStats(recordsA)
      expect(resultA[0].lastCallRawPromptTokens).toBe(22000)

      // Case B: First record is undefined, second is defined.
      // Expect lastCallRawPromptTokens to be the second record's defined value.
      const recordsB: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: undefined,
          peakInputTokens: 150,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          lastCallRawPromptTokens: 33000,
          peakInputTokens: 210,
        },
      ]

      const resultB = aggregateModelStats(recordsB)
      expect(resultB[0].lastCallRawPromptTokens).toBe(33000)

      // Case C: Both records are undefined.
      // Expect lastCallRawPromptTokens to be undefined.
      const recordsC: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          peakInputTokens: 150,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          peakInputTokens: 210,
        },
      ]

      const resultC = aggregateModelStats(recordsC)
      expect(resultC[0].lastCallRawPromptTokens).toBeUndefined()
    })

    it("confirms other fields (inputTokens, outputTokens, cost, cacheRead, cacheWrite, visibleOutputTokens) still sum correctly alongside this new non-summed field", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 20000,
          peakInputTokens: 150,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          lastCallRawPromptTokens: 35000,
          peakInputTokens: 210,
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0]).toEqual({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 2,
        inputTokens: 250, // 100 + 150
        outputTokens: 450, // 200 + 250
        cacheRead: 110, // 50 + 60
        cacheWrite: 30, // 10 + 20
        cost: 0.0035, // 0.0015 + 0.002
        visibleOutputTokens: 310, // 150 + 160
        lastCallRawPromptTokens: 35000, // last wins!
        peakInputTokens: 210, // max of 150 and 210
      })
    })

    it("preserves last real positive value when the last record has 0 or undefined lastCallRawPromptTokens", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 25000,
          peakInputTokens: 150,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          visibleOutputTokens: 0,
          lastCallRawPromptTokens: 0, // degenerate last call
          peakInputTokens: 0,
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0].lastCallRawPromptTokens).toBe(25000)

      // Test with undefined as well
      const recordsWithUndefined: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 25000,
          peakInputTokens: 150,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          visibleOutputTokens: 0,
          lastCallRawPromptTokens: undefined, // degenerate last call
          peakInputTokens: 0,
        },
      ]

      const resultWithUndefined = aggregateModelStats(recordsWithUndefined)
      expect(resultWithUndefined[0].lastCallRawPromptTokens).toBe(25000)
    })

    it("ensures the chronologically last non-zero value wins when a middle record has 0 lastCallRawPromptTokens", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 15000, // first real
          peakInputTokens: 150,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          visibleOutputTokens: 0,
          lastCallRawPromptTokens: 0, // middle 0
          peakInputTokens: 0,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          lastCallRawPromptTokens: 30000, // last real (wins)
          peakInputTokens: 210,
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0].lastCallRawPromptTokens).toBe(30000)
    })

    it("retains 0 lastCallRawPromptTokens when it is the only record for a model", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          visibleOutputTokens: 0,
          lastCallRawPromptTokens: 0,
          peakInputTokens: 0,
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0].lastCallRawPromptTokens).toBe(0)
    })

    it("verifies other summed fields aggregate correctly regardless of the 0/undefined lastCallRawPromptTokens guard", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 25000,
          peakInputTokens: 150,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 50,
          outputTokens: 100,
          cacheRead: 20,
          cacheWrite: 5,
          cost: 0.0005,
          visibleOutputTokens: 80,
          lastCallRawPromptTokens: 0, // should be ignored for raw prompt but others should sum
          peakInputTokens: 70,
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0]).toEqual({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 2,
        inputTokens: 150,
        outputTokens: 300,
        cacheRead: 70,
        cacheWrite: 15,
        cost: 0.0020,
        visibleOutputTokens: 230,
        lastCallRawPromptTokens: 25000, // retains prior value
        peakInputTokens: 150, // max of 150 and 70
      })
    })
  })
})

// ─── countModelSwitches ─────────────────────────────────────────────────────

describe("countModelSwitches", () => {
  it("returns 0 when all messages use the same model (no switches)", () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      id: `msg${i}`,
      info: { role: "assistant", providerID: "a", modelID: "m1", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } },
    }))
    expect(countModelSwitches(messages)).toBe(0)
  })

  it("detects 1 switch when model changes once", () => {
    const messages = [
      { id: "msg1", info: { role: "assistant", providerID: "a", modelID: "m1", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "msg2", info: { role: "assistant", providerID: "a", modelID: "m1", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "msg3", info: { role: "assistant", providerID: "a", modelID: "m1", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "msg4", info: { role: "assistant", providerID: "a", modelID: "m2", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "msg5", info: { role: "assistant", providerID: "a", modelID: "m2", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
    ]
    expect(countModelSwitches(messages)).toBe(1)
  })

  it("detects 3 switches for A→B→A→B pattern", () => {
    const messages = [
      { id: "msg1", info: { role: "assistant", providerID: "a", modelID: "m1", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "msg2", info: { role: "assistant", providerID: "b", modelID: "m2", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "msg3", info: { role: "assistant", providerID: "a", modelID: "m1", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "msg4", info: { role: "assistant", providerID: "b", modelID: "m2", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
    ]
    expect(countModelSwitches(messages)).toBe(3)
  })

  it("skips title-gen calls (rawPromptTokens === 0) when counting switches", () => {
    // A(real) → A(title-gen, rawPrompt=0) → B(real)
    // Title-gen should be IGNORED — only A→B = 1 switch, not A→title-gen + title-gen→B = 2
    const messages = [
      { id: "msg1", info: { role: "assistant", providerID: "p", modelID: "m1", tokens: { input: 500, output: 200, cache: { read: 0, write: 0 } } } },
      { id: "msg_title", info: { role: "assistant", providerID: "p", modelID: "m-title", tokens: { input: 0, output: 200, cache: { read: 0, write: 0 } } } },
      { id: "msg2", info: { role: "assistant", providerID: "p", modelID: "m2", tokens: { input: 300, output: 100, cache: { read: 0, write: 0 } } } },
    ]
    expect(countModelSwitches(messages)).toBe(1)
  })

  it("skips non-assistant messages (user role) entirely", () => {
    const messages = [
      { id: "m1", info: { role: "assistant", providerID: "a", modelID: "m1", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "u1", info: { role: "user" } },
      { id: "m2", info: { role: "assistant", providerID: "a", modelID: "m2", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
    ]
    // user message in between should not break the switch detection
    expect(countModelSwitches(messages)).toBe(1)
  })

  it("skips messages without providerID/modelID", () => {
    const messages = [
      { id: "m1", info: { role: "assistant", providerID: "a", modelID: "m1", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "no_provider", info: { role: "assistant", modelID: "m2", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "no_model", info: { role: "assistant", providerID: "a", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
      { id: "m2", info: { role: "assistant", providerID: "b", modelID: "m2", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } } },
    ]
    // Messages without providerID/modelID are skipped — switch is A→B = 1
    expect(countModelSwitches(messages)).toBe(1)
  })
})

// ─── computeModelsTabLayout ─────────────────────────────────────────────────

describe("computeModelsTabLayout", () => {
  it("sorts by modelTokens (peakInput+output) descending", () => {
    const stats: ModelStat[] = [
      { providerID: "p", modelID: "A", msgCount: 1, inputTokens: 1000, outputTokens: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, visibleOutputTokens: 400, peakInputTokens: 1000 },
      { providerID: "p", modelID: "B", msgCount: 1, inputTokens: 500, outputTokens: 200, cacheRead: 0, cacheWrite: 0, cost: 0.005, visibleOutputTokens: 150, peakInputTokens: 500 },
    ]
    const { sortedStats } = computeModelsTabLayout(stats)
    expect(sortedStats[0].modelID).toBe("A")
    expect(sortedStats[1].modelID).toBe("B")
  })

  it("falls back to msgCount desc when modelTokens are equal", () => {
    const stats: ModelStat[] = [
      { providerID: "p", modelID: "A", msgCount: 3, inputTokens: 500, outputTokens: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, visibleOutputTokens: 400, peakInputTokens: 500 },
      { providerID: "p", modelID: "B", msgCount: 5, inputTokens: 500, outputTokens: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, visibleOutputTokens: 400, peakInputTokens: 500 },
    ]
    const { sortedStats } = computeModelsTabLayout(stats)
    // B has higher msgCount, so B should come first
    expect(sortedStats[0].modelID).toBe("B")
    expect(sortedStats[1].modelID).toBe("A")
  })

  it("falls back to modelID asc when modelTokens and msgCount are equal", () => {
    const stats: ModelStat[] = [
      { providerID: "p", modelID: "bbb", msgCount: 1, inputTokens: 500, outputTokens: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, visibleOutputTokens: 400, peakInputTokens: 500 },
      { providerID: "p", modelID: "aaa", msgCount: 1, inputTokens: 500, outputTokens: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, visibleOutputTokens: 400, peakInputTokens: 500 },
    ]
    const { sortedStats } = computeModelsTabLayout(stats)
    // "p/aaa" < "p/bbb", so aaa comes first
    expect(sortedStats[0].modelID).toBe("aaa")
    expect(sortedStats[1].modelID).toBe("bbb")
  })

  it("computes totalModelTokens correctly", () => {
    const stats: ModelStat[] = [
      { providerID: "p", modelID: "A", msgCount: 1, inputTokens: 1000, outputTokens: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, visibleOutputTokens: 400, peakInputTokens: 1000 },
      { providerID: "p", modelID: "B", msgCount: 1, inputTokens: 500, outputTokens: 200, cacheRead: 0, cacheWrite: 0, cost: 0.005, visibleOutputTokens: 150, peakInputTokens: 500 },
    ]
    const { totalModelTokens } = computeModelsTabLayout(stats)
    expect(totalModelTokens).toBe(2200) // (1000+500) + (500+200)
  })

  it("computes correct percentage per model", () => {
    const stats: ModelStat[] = [
      { providerID: "p", modelID: "A", msgCount: 1, inputTokens: 1000, outputTokens: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, visibleOutputTokens: 400, peakInputTokens: 1000 },
      { providerID: "p", modelID: "B", msgCount: 1, inputTokens: 500, outputTokens: 200, cacheRead: 0, cacheWrite: 0, cost: 0.005, visibleOutputTokens: 150, peakInputTokens: 500 },
    ]
    const { sortedStats, totalModelTokens } = computeModelsTabLayout(stats)
    const pctA = ((sortedStats[0].peakInputTokens + sortedStats[0].outputTokens) / totalModelTokens) * 100
    const pctB = ((sortedStats[1].peakInputTokens + sortedStats[1].outputTokens) / totalModelTokens) * 100
    expect(pctA).toBeCloseTo(68.18, 1)
    expect(pctB).toBeCloseTo(31.82, 1)
  })

  it("single model returns pct=100", () => {
    const stats: ModelStat[] = [
      { providerID: "p", modelID: "A", msgCount: 1, inputTokens: 300, outputTokens: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01, visibleOutputTokens: 400, peakInputTokens: 300 },
    ]
    const { sortedStats, totalModelTokens } = computeModelsTabLayout(stats)
    expect(sortedStats.length).toBe(1)
    expect(totalModelTokens).toBe(500)
    const pct = ((sortedStats[0].peakInputTokens + sortedStats[0].outputTokens) / totalModelTokens) * 100
    expect(pct).toBe(100)
  })
})

// ─── costPerMillion ──────────────────────────────────────────────────────────

describe("costPerMillion", () => {
  const mk = (providerID: string, modelID: string, totalCost: number, totalInput: number, totalOutput: number): ModelUsage => ({
    providerID,
    modelID,
    totalCost,
    totalInput,
    totalOutput,
  })

  it("computes cost per million tokens using the correct formula", () => {
    // totalCost=3, totalInput=600, totalOutput=400 -> total=1000
    // (3 / 1000) * 1_000_000 = 3000
    expect(costPerMillion(mk("anthropic", "claude-3-5-sonnet", 3, 600, 400))).toBe(3000)
  })

  it("returns 0 when totalCost is 0 but tokens are non-zero", () => {
    expect(costPerMillion(mk("openai", "gpt-4o-mini", 0, 500, 500))).toBe(0)
  })

  it("returns 0 for a free model even with many tokens", () => {
    expect(costPerMillion(mk("copilot", "free-model", 0, 1000, 2000))).toBe(0)
  })

  it("returns null when totalInput + totalOutput === 0", () => {
    expect(costPerMillion(mk("anthropic", "claude-3-5-sonnet", 3, 0, 0))).toBeNull()
    expect(costPerMillion(mk("openai", "gpt-4o", 0, 0, 0))).toBeNull()
  })

  it("handles fractional costs producing fractional per-million values", () => {
    // totalCost=0.001, totalInput=100, totalOutput=100 -> total=200
    // (0.001 / 200) * 1_000_000 = 5
    expect(costPerMillion(mk("openai", "gpt-4o", 0.001, 100, 100))).toBe(5)
  })
})

// ─── sortModels ──────────────────────────────────────────────────────────────

describe("sortModels", () => {
  const mk = (providerID: string, modelID: string, totalCost: number, totalInput: number, totalOutput: number): ModelUsage => ({
    providerID,
    modelID,
    totalCost,
    totalInput,
    totalOutput,
  })

  it("sorts descending by (totalInput + totalOutput) for key \"tokens\"", () => {
    const models: ModelUsage[] = [
      mk("openai", "gpt-4o-mini", 0.01, 100, 50), // 150
      mk("anthropic", "claude-3-5-sonnet", 0.05, 1000, 900), // 1900
      mk("openai", "gpt-4o", 0.03, 500, 100), // 600
    ]

    const result = sortModels(models, "tokens")
    expect(result.map(m => m.modelID)).toEqual(["claude-3-5-sonnet", "gpt-4o", "gpt-4o-mini"])
    // highest token total first, regardless of cost
    expect(result[0].totalInput + result[0].totalOutput).toBe(1900)
    expect(result[1].totalInput + result[1].totalOutput).toBe(600)
    expect(result[2].totalInput + result[2].totalOutput).toBe(150)
  })

  it("sorts descending by totalCost for key \"cost\", independent of tokens", () => {
    const models: ModelUsage[] = [
      mk("openai", "gpt-4o-mini", 0.01, 10000, 10000), // high tokens, low cost
      mk("anthropic", "claude-3-5-sonnet", 0.05, 100, 100), // low tokens, high cost
      mk("openai", "gpt-4o", 0.03, 500, 500),
    ]

    const result = sortModels(models, "cost")
    expect(result.map(m => m.modelID)).toEqual(["claude-3-5-sonnet", "gpt-4o", "gpt-4o-mini"])
    expect(result[0].totalCost).toBe(0.05)
    expect(result[1].totalCost).toBe(0.03)
    expect(result[2].totalCost).toBe(0.01)
  })

  it("does not mutate the input array", () => {
    const models: ModelUsage[] = [
      mk("b", "m2", 0.02, 200, 100),
      mk("a", "m1", 0.03, 100, 50),
      mk("c", "m3", 0.01, 500, 400),
    ]
    const before = [...models]

    const result = sortModels(models, "tokens")

    expect(result).not.toBe(models)
    expect(models).toEqual(before)
    expect(models.map(m => m.modelID)).toEqual(["m2", "m1", "m3"])
  })

  it("breaks ties deterministically by providerID/modelID ascending", () => {
    const models: ModelUsage[] = [
      mk("zeta", "model-b", 0.02, 100, 100), // equal sort key
      mk("alpha", "model-b", 0.02, 100, 100),
      mk("alpha", "model-a", 0.02, 100, 100),
    ]
    // All have identical sort values for both keys; order must be stable by "providerID/modelID".
    const result = sortModels(models, "tokens")
    const keys = result.map(m => `${m.providerID}/${m.modelID}`)
    expect(keys).toEqual(["alpha/model-a", "alpha/model-b", "zeta/model-b"])
  })

  it("breaks cost ties deterministically by providerID/modelID ascending", () => {
    const models: ModelUsage[] = [
      mk("beta", "x", 0.01, 1, 1),
      mk("alpha", "x", 0.01, 1, 1),
    ]
    const result = sortModels(models, "cost")
    expect(result.map(m => m.providerID)).toEqual(["alpha", "beta"])
  })

  it("returns an empty array for empty input", () => {
    expect(sortModels([], "tokens")).toEqual([])
    expect(sortModels([], "cost")).toEqual([])
  })

  it("defaults to tokens ordering for an unknown key", () => {
    const models: ModelUsage[] = [
      mk("a", "m1", 0.99, 10, 10), // 20 tokens
      mk("b", "m2", 0.01, 1000, 1000), // 2000 tokens
    ]
    // Cast through unknown to exercise the switch `default` branch.
    const result = sortModels(models, "bogus" as ModelSortKey)
    expect(result.map(m => m.modelID)).toEqual(["m2", "m1"])
  })

  // ── price (cost per million) ─────────────────────────────────────────────

  it('sorts ascending by costPerMillion for key "price" (cheapest first)', () => {
    const models: ModelUsage[] = [
      // costPerMillion: (3/1000)*1e6 = 3000
      mk("anthropic", "claude-3-5-sonnet", 3, 600, 400),
      // (1/2000)*1e6 = 500
      mk("openai", "gpt-4o-mini", 1, 1000, 1000),
      // (5/1000)*1e6 = 5000
      mk("openai", "gpt-4o", 5, 500, 500),
    ]
    const result = sortModels(models, "price")
    expect(result.map(m => m.modelID)).toEqual(["gpt-4o-mini", "claude-3-5-sonnet", "gpt-4o"])
    expect(result[0].modelID).toBe("gpt-4o-mini") // cheapest first
    expect(result[2].modelID).toBe("gpt-4o") // most expensive last
  })

  it('sorts zero-token models last for key "price"', () => {
    const models: ModelUsage[] = [
      mk("openai", "gpt-4o-mini", 1, 1000, 1000), // price 500
      mk("anthropic", "claude-3-5-sonnet", 0, 0, 0), // zero tokens -> null
      mk("openai", "gpt-4o", 5, 500, 500), // price 5000
    ]
    const result = sortModels(models, "price")
    expect(result.map(m => m.modelID)).toEqual(["gpt-4o-mini", "gpt-4o", "claude-3-5-sonnet"])
    // zero-token model last regardless of its cost
    expect(result[2].providerID + "/" + result[2].modelID).toBe("anthropic/claude-3-5-sonnet")
  })

  it('sorts multiple zero-token models after all priced models for key "price"', () => {
    const models: ModelUsage[] = [
      mk("a", "priced", 1, 100, 100), // price 5000
      mk("b", "zero-one", 0, 0, 0), // null
      mk("c", "zero-two", 0, 0, 0), // null
    ]
    const result = sortModels(models, "price")
    expect(result.map(m => m.modelID)).toEqual(["priced", "zero-one", "zero-two"])
  })

  it('sorts free models (totalCost 0) first for key "price"', () => {
    const models: ModelUsage[] = [
      mk("openai", "gpt-4o", 5, 500, 500), // price 5000
      mk("copilot", "free-model", 0, 1000, 1000), // price 0 -> cheapest
      mk("openai", "gpt-4o-mini", 1, 1000, 1000), // price 500
    ]
    const result = sortModels(models, "price")
    expect(result.map(m => m.modelID)).toEqual(["free-model", "gpt-4o-mini", "gpt-4o"])
    expect(result[0].totalCost).toBe(0)
  })

  it('breaks equal-price ties deterministically by providerID/modelID ascending for "price"', () => {
    // All have identical costPerMillion -> tie broken by providerID/modelID asc.
    const models: ModelUsage[] = [
      mk("zeta", "model-b", 1, 100, 100),
      mk("alpha", "model-b", 1, 100, 100),
      mk("alpha", "model-a", 1, 100, 100),
    ]
    const result = sortModels(models, "price")
    const keys = result.map(m => `${m.providerID}/${m.modelID}`)
    expect(keys).toEqual(["alpha/model-a", "alpha/model-b", "zeta/model-b"])
  })

  it('does not mutate the input array for key "price"', () => {
    const models: ModelUsage[] = [
      mk("b", "m2", 2, 100, 100),
      mk("a", "m1", 1, 100, 100),
      mk("c", "m3", 3, 100, 100),
    ]
    const before = [...models]
    const result = sortModels(models, "price")
    expect(result).not.toBe(models)
    expect(models).toEqual(before)
    expect(models.map(m => m.modelID)).toEqual(["m2", "m1", "m3"])
  })

  it('returns an empty array for empty input with key "price"', () => {
    expect(sortModels([], "price")).toEqual([])
  })
})
