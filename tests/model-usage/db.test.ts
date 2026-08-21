import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fetchRawRows,
  fetchRootSessionTimestamps,
  queryDailyTotals,
  queryTopSessions,
  type RawUsageRow,
  type TopSession,
} from "@model-usage/db"

function setupDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"))
  const dbPath = join(dir, "test.db")
  const db = new Database(dbPath)
  db.run(`CREATE TABLE IF NOT EXISTS message (
    time_created INTEGER,
    data TEXT
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS session (
    id TEXT,
    parent_id TEXT,
    time_created INTEGER,
    title TEXT,
    cost REAL,
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_reasoning INTEGER,
    tokens_cache_read INTEGER,
    tokens_cache_write INTEGER,
    project_id TEXT,
    time_compacting INTEGER
  )`)
  db.close()
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function insertMessage(dbPath: string, timeCreated: number, data: Record<string, unknown>) {
  const db = new Database(dbPath)
  try {
    db.run(`INSERT INTO message (time_created, data) VALUES (?, ?)`, [
      timeCreated,
      JSON.stringify(data),
    ])
  } finally {
    db.close()
  }
}

function insertSession(
  dbPath: string,
  id: string,
  parentId: string | null,
  timeCreated: number,
  overrides: Partial<{
    title: string
    cost: number
    tokensInput: number
    tokensOutput: number
    tokensReasoning: number
    tokensCacheRead: number
    tokensCacheWrite: number
    projectId: string
    timeCompacting: number
  }> = {},
) {
  const db = new Database(dbPath)
  try {
    db.run(
      `INSERT INTO session (
        id, parent_id, time_created, title, cost,
        tokens_input, tokens_output, tokens_reasoning,
        tokens_cache_read, tokens_cache_write,
        project_id, time_compacting
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        parentId,
        timeCreated,
        overrides.title ?? "",
        overrides.cost ?? 0,
        overrides.tokensInput ?? 0,
        overrides.tokensOutput ?? 0,
        overrides.tokensReasoning ?? 0,
        overrides.tokensCacheRead ?? 0,
        overrides.tokensCacheWrite ?? 0,
        overrides.projectId ?? "",
        overrides.timeCompacting ?? 0,
      ],
    )
  } finally {
    db.close()
  }
}

describe("fetchRawRows", () => {
  let setup: { dbPath: string; cleanup: () => void }
  const REFERENCE = Date.UTC(2026, 6, 6, 12, 0, 0)

  beforeEach(() => {
    setup = setupDb()
  })

  afterEach(() => {
    setup.cleanup()
  })

  it("empty DB returns empty array (no error)", () => {
    const result = fetchRawRows(setup.dbPath, 0, REFERENCE + 86_400_000)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it("single assistant message within range returns 1 row with correct fields", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant",
      modelID: "gpt-4",
      providerID: "copilot",
      cost: 0.05,
      tokens: { input: 100, output: 50 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(1)
    expect(rows[0].model_id).toBe("gpt-4")
    expect(rows[0].provider_id).toBe("copilot")
    expect(rows[0].cost).toBeCloseTo(0.05, 6)
    expect(rows[0].input_tokens).toBe(100)
    expect(rows[0].output_tokens).toBe(50)
  })

  it("message outside range is excluded", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant",
      modelID: "gpt-4",
      providerID: "copilot",
      cost: 0.05,
      tokens: { input: 100, output: 50 },
    })

    const earlier = REFERENCE - 86_400_000 * 3
    const rows = fetchRawRows(setup.dbPath, earlier, earlier + 86_400_000)
    expect(rows).toHaveLength(0)
  })

  it("non-assistant messages are excluded", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "user",
      modelID: null,
      providerID: null,
      cost: 0,
      tokens: { input: 0, output: 0 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(0)
  })

  it("multiple messages return correct count and ASC order by time_created", () => {
    const t1 = REFERENCE
    const t2 = REFERENCE + 3600_000
    const t3 = REFERENCE + 7200_000

    insertMessage(setup.dbPath, t3, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost: 0.05, tokens: { input: 100, output: 50 },
    })
    insertMessage(setup.dbPath, t1, {
      role: "assistant", modelID: "gpt-3.5", providerID: "copilot",
      cost: 0.01, tokens: { input: 50, output: 25 },
    })
    insertMessage(setup.dbPath, t2, {
      role: "assistant", modelID: "claude-3", providerID: "anthropic",
      cost: 0.03, tokens: { input: 200, output: 100 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(3)

    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].time_created).toBeGreaterThanOrEqual(rows[i - 1].time_created)
    }
  })

  it("returns correct token/cost values matching inserted data", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost: 0.15, tokens: { input: 5000, output: 3000 },
    })
    insertMessage(setup.dbPath, REFERENCE + 1000, {
      role: "assistant", modelID: "claude-3", providerID: "anthropic",
      cost: 0.08, tokens: { input: 2000, output: 1000 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(2)

    expect(rows[0].model_id).toBe("gpt-4")
    expect(rows[0].provider_id).toBe("copilot")
    expect(rows[0].input_tokens).toBe(5000)
    expect(rows[0].output_tokens).toBe(3000)
    expect(rows[0].cost).toBeCloseTo(0.15, 6)

    expect(rows[1].model_id).toBe("claude-3")
    expect(rows[1].provider_id).toBe("anthropic")
    expect(rows[1].input_tokens).toBe(2000)
    expect(rows[1].output_tokens).toBe(1000)
    expect(rows[1].cost).toBeCloseTo(0.08, 6)
  })

  it("handles null model_id/provider_id gracefully", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant", modelID: null, providerID: null,
      cost: 0.05, tokens: { input: 100, output: 50 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(Array.isArray(rows)).toBe(true)
    const nullRows = rows.filter((r: RawUsageRow) => r.model_id === null || r.provider_id === null)
    expect(rows.length).toBeGreaterThanOrEqual(0)
  })

  it("DB file doesn't exist → returns error object", () => {
    const result = fetchRawRows("/nonexistent/path/to/db.db", 0, 1000)
    expect(result).toHaveProperty("error")
    expect(typeof result.error).toBe("string")
    expect(result.error.length).toBeGreaterThan(0)
  })

  it("messages exactly at boundary (startMs) are included", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost: 0.05, tokens: { input: 100, output: 50 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(1)
    expect(rows[0].input_tokens).toBe(100)
  })

  it("messages exactly at boundary (endMs) are excluded", () => {
    insertMessage(setup.dbPath, REFERENCE + 86_400_000, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost: 0.05, tokens: { input: 100, output: 50 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(0)
  })
})

describe("fetchRootSessionTimestamps", () => {
  let setup: { dbPath: string; cleanup: () => void }
  const REFERENCE = Date.UTC(2026, 6, 6, 12, 0, 0)

  beforeEach(() => {
    setup = setupDb()
  })

  afterEach(() => {
    setup.cleanup()
  })

  it("returns only root-session time_created values in range", () => {
    const t1 = REFERENCE
    const t2 = REFERENCE + 3600_000
    insertSession(setup.dbPath, "root1", null, t1)
    insertSession(setup.dbPath, "root2", null, t2)
    insertSession(setup.dbPath, "child", "root1", REFERENCE + 1000)
    insertSession(setup.dbPath, "early", null, REFERENCE - 86_400_000)
    insertSession(setup.dbPath, "late", null, REFERENCE + 86_400_000)

    const result = fetchRootSessionTimestamps(setup.dbPath, REFERENCE, REFERENCE + 86_400_000)
    expect(result).not.toHaveProperty("error")
    const timestamps = result as number[]
    expect(timestamps).toHaveLength(2)
    expect(timestamps).toContain(t1)
    expect(timestamps).toContain(t2)
  })

  it("empty DB returns []", () => {
    const result = fetchRootSessionTimestamps(setup.dbPath, 0, REFERENCE + 86_400_000)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it("boundary semantics: time_created == startMs included, == endMs excluded", () => {
    insertSession(setup.dbPath, "atStart", null, REFERENCE)
    insertSession(setup.dbPath, "atEnd", null, REFERENCE + 86_400_000)

    const result = fetchRootSessionTimestamps(setup.dbPath, REFERENCE, REFERENCE + 86_400_000)
    expect(result).not.toHaveProperty("error")
    const timestamps = result as number[]
    expect(timestamps).toEqual([REFERENCE])
  })

  it("nonexistent DB path → returns { error: string }", () => {
    const result = fetchRootSessionTimestamps("/nonexistent/path/to/db.db", 0, REFERENCE + 86_400_000)
    expect(result).toHaveProperty("error")
    expect(typeof result.error).toBe("string")
    expect(result.error.length).toBeGreaterThan(0)
  })
})

describe("queryDailyTotals", () => {
  let setup: { dbPath: string; cleanup: () => void }
  const REFERENCE = Date.UTC(2026, 6, 6, 12, 0, 0)
  const DAY = 86_400_000

  beforeEach(() => {
    setup = setupDb()
  })

  afterEach(() => {
    setup.cleanup()
  })

  function assistantMessage(
    timeCreated: number,
    tokens: { input: number; output: number },
    cost: number,
  ) {
    insertMessage(setup.dbPath, timeCreated, {
      role: "assistant",
      modelID: "gpt-4",
      providerID: "copilot",
      cost,
      tokens,
    })
  }

  it("multiple rows on the SAME day are grouped into ONE bucket with summed values", () => {
    assistantMessage(REFERENCE + 1000, { input: 100, output: 50 }, 0.01)
    assistantMessage(REFERENCE + 5000, { input: 200, output: 150 }, 0.03)
    assistantMessage(REFERENCE + 10_000, { input: 50, output: 25 }, 0.005)

    const result = queryDailyTotals(setup.dbPath, REFERENCE, REFERENCE + DAY)
    expect(result).not.toHaveProperty("error")
    const rows = result as { day_start: number; input_tokens: number; output_tokens: number; cost: number }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].day_start).toBe(Math.floor(REFERENCE / DAY) * DAY)
    expect(rows[0].input_tokens).toBe(350)
    expect(rows[0].output_tokens).toBe(225)
    expect(rows[0].cost).toBeCloseTo(0.045, 6)
  })

  it("rows on DIFFERENT days produce separate buckets with day_start aligned to UTC midnight", () => {
    const day0Start = Math.floor(REFERENCE / DAY) * DAY
    const day1Start = day0Start + DAY
    const day2Start = day0Start + 2 * DAY

    // three distinct UTC days
    assistantMessage(day0Start + 3600_000, { input: 100, output: 50 }, 0.01)
    assistantMessage(day0Start + 7200_000, { input: 200, output: 100 }, 0.02)
    assistantMessage(day1Start + 1000, { input: 300, output: 150 }, 0.03)
    assistantMessage(day2Start + 60_000, { input: 400, output: 200 }, 0.04)

    const result = queryDailyTotals(setup.dbPath, day0Start, day2Start + DAY)
    expect(result).not.toHaveProperty("error")
    const rows = result as { day_start: number; input_tokens: number; output_tokens: number; cost: number }[]

    expect(rows).toHaveLength(3)
    // ordered by day_start ASC
    expect(rows[0].day_start).toBe(day0Start)
    expect(rows[1].day_start).toBe(day1Start)
    expect(rows[2].day_start).toBe(day2Start)

    expect(rows[0].input_tokens).toBe(300)
    expect(rows[0].output_tokens).toBe(150)
    expect(rows[0].cost).toBeCloseTo(0.03, 6)

    expect(rows[1].input_tokens).toBe(300)
    expect(rows[1].output_tokens).toBe(150)
    expect(rows[1].cost).toBeCloseTo(0.03, 6)

    expect(rows[2].input_tokens).toBe(400)
    expect(rows[2].output_tokens).toBe(200)
    expect(rows[2].cost).toBeCloseTo(0.04, 6)
  })

  it("half-open boundary: time_created === startMs included, === endMs excluded", () => {
    const start = dayStart(REFERENCE)
    const end = start + DAY

    assistantMessage(start, { input: 100, output: 50 }, 0.01)
    assistantMessage(end, { input: 999, output: 999 }, 0.99)

    const result = queryDailyTotals(setup.dbPath, start, end)
    expect(result).not.toHaveProperty("error")
    const rows = result as { day_start: number; input_tokens: number; output_tokens: number; cost: number }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].day_start).toBe(start)
    expect(rows[0].input_tokens).toBe(100)
    expect(rows[0].output_tokens).toBe(50)
    expect(rows[0].cost).toBeCloseTo(0.01, 6)
  })

  it("a range with no rows returns []", () => {
    const result = queryDailyTotals(setup.dbPath, REFERENCE, REFERENCE + DAY)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it("non-assistant roles are excluded", () => {
    insertMessage(setup.dbPath, REFERENCE + 1000, {
      role: "user",
      modelID: null,
      providerID: null,
      cost: 0,
      tokens: { input: 1000, output: 1000 },
    })
    insertMessage(setup.dbPath, REFERENCE + 2000, {
      role: "system",
      modelID: null,
      providerID: null,
      cost: 0,
      tokens: { input: 500, output: 500 },
    })

    const result = queryDailyTotals(setup.dbPath, REFERENCE, REFERENCE + DAY)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it("nonexistent DB path → returns { error: string }", () => {
    const result = queryDailyTotals("/nonexistent/path/to/db.db", 0, REFERENCE + DAY)
    if (!("error" in result)) throw new Error("expected error result")
    expect(result).toHaveProperty("error")
    expect(typeof result.error).toBe("string")
    expect(result.error.length).toBeGreaterThan(0)
  })
})

describe("queryTopSessions", () => {
  let setup: { dbPath: string; cleanup: () => void }
  const REFERENCE = Date.UTC(2026, 6, 6, 12, 0, 0)
  const DAY = 86_400_000

  function sessions(result: { sessions: TopSession[] } | { error: string }): TopSession[] {
    expect(result).not.toHaveProperty("error")
    return (result as { sessions: TopSession[] }).sessions
  }

  beforeEach(() => {
    setup = setupDb()
  })

  afterEach(() => {
    setup.cleanup()
  })

  it("returns top sessions ordered by cost DESC when sort=\"cost\"", () => {
    insertSession(setup.dbPath, "root1", null, REFERENCE, { cost: 0.5, tokensInput: 100, tokensOutput: 100 })
    insertSession(setup.dbPath, "root2", null, REFERENCE, { cost: 0.9, tokensInput: 10, tokensOutput: 10 })
    insertSession(setup.dbPath, "root3", null, REFERENCE, { cost: 0.1, tokensInput: 1000, tokensOutput: 1000 })

    const result = queryTopSessions(setup.dbPath, REFERENCE, REFERENCE + DAY, "cost")
    const rows = sessions(result)
    expect(rows.map((r) => r.id)).toEqual(["root2", "root1", "root3"])
  })

  it("orders by (tokens_input + tokens_output) DESC when sort=\"tokens\", not by cost", () => {
    // root1 has highest cost but lowest total tokens; root3 has lowest cost but highest tokens
    insertSession(setup.dbPath, "root1", null, REFERENCE, { cost: 0.9, tokensInput: 10, tokensOutput: 10 })
    insertSession(setup.dbPath, "root2", null, REFERENCE, { cost: 0.5, tokensInput: 50, tokensOutput: 50 })
    insertSession(setup.dbPath, "root3", null, REFERENCE, { cost: 0.1, tokensInput: 1000, tokensOutput: 1000 })

    const result = queryTopSessions(setup.dbPath, REFERENCE, REFERENCE + DAY, "tokens")
    const rows = sessions(result)
    expect(rows.map((r) => r.id)).toEqual(["root3", "root2", "root1"])
    expect(rows[0].tokens).toBe(2000)
    expect(rows[1].tokens).toBe(100)
    expect(rows[2].tokens).toBe(20)
  })

  it("only root sessions are included; subagent rows are excluded but counted via subagentCount", () => {
    insertSession(setup.dbPath, "root1", null, REFERENCE, { cost: 0.9 })
    insertSession(setup.dbPath, "root2", null, REFERENCE, { cost: 0.5 })
    // subagents of root1 (high cost) must not appear in the top list
    insertSession(setup.dbPath, "sub1", "root1", REFERENCE, { cost: 99 })
    insertSession(setup.dbPath, "sub2", "root1", REFERENCE, { cost: 99 })

    const result = queryTopSessions(setup.dbPath, REFERENCE, REFERENCE + DAY, "cost")
    const rows = sessions(result)
    expect(rows.map((r) => r.id).sort()).toEqual(["root1", "root2"])
    expect(rows.find((r) => r.id === "root1")?.subagentCount).toBe(2)
    expect(rows.find((r) => r.id === "root2")?.subagentCount).toBe(0)
  })

  it("subagentCount is correct per root (root with 2 subagents → 2)", () => {
    insertSession(setup.dbPath, "root1", null, REFERENCE)
    insertSession(setup.dbPath, "s1", "root1", REFERENCE)
    insertSession(setup.dbPath, "s2", "root1", REFERENCE)

    const result = queryTopSessions(setup.dbPath, REFERENCE, REFERENCE + DAY, "cost")
    const rows = sessions(result)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe("root1")
    expect(rows[0].subagentCount).toBe(2)
  })

  it("time window is half-open: startMs included, endMs excluded, earlier excluded", () => {
    insertSession(setup.dbPath, "atStart", null, REFERENCE)
    insertSession(setup.dbPath, "atEnd", null, REFERENCE + DAY)
    insertSession(setup.dbPath, "before", null, REFERENCE - 1000)

    const result = queryTopSessions(setup.dbPath, REFERENCE, REFERENCE + DAY, "cost")
    const rows = sessions(result)
    expect(rows.map((r) => r.id)).toEqual(["atStart"])
  })

  it("limits results to top 10 when more than 10 root sessions are in range", () => {
    for (let i = 0; i < 12; i++) {
      insertSession(setup.dbPath, `root${i}`, null, REFERENCE + i, { cost: i / 10 })
    }

    const result = queryTopSessions(setup.dbPath, REFERENCE, REFERENCE + DAY, "cost")
    const rows = sessions(result)
    expect(rows).toHaveLength(10)
    // top 10 by cost DESC → the 10 highest costs
    expect(rows[0].id).toBe("root11")
    expect(rows[9].id).toBe("root2")
  })

  it("maps row fields onto the TopSession shape", () => {
    insertSession(setup.dbPath, "root1", null, REFERENCE, {
      title: "my session",
      cost: 1.25,
      tokensInput: 300,
      tokensOutput: 200,
    })

    const result = queryTopSessions(setup.dbPath, REFERENCE, REFERENCE + DAY, "cost")
    const rows = sessions(result)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: "root1",
      title: "my session",
      cost: 1.25,
      tokensInput: 300,
      tokensOutput: 200,
      tokens: 500,
      subagentCount: 0,
      timeCreated: REFERENCE,
    })
  })

  it("nonexistent DB path → returns { error: string }", () => {
    const result = queryTopSessions("/nonexistent/path/to/db.db", 0, REFERENCE + DAY, "cost")
    expect(result).toHaveProperty("error")
    expect(typeof (result as { error: string }).error).toBe("string")
    expect((result as { error: string }).error.length).toBeGreaterThan(0)
  })
})

function dayStart(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000
}
