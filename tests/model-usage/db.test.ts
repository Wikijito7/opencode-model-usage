import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  detectUsageSchema,
  fetchRawRows,
  fetchRootSessionTimestamps,
  getEarliestUsageDate,
  queryDailyTotals,
  queryTopSessions,
  queryUsage,
  type RawUsageRow,
  type TopSession,
  type UsageSchemaInfo,
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
    expect(rows).not.toHaveProperty("error")
    if (!Array.isArray(rows)) throw new Error("expected rows array")

    // An assistant row is selected by `role`, not by model/provider, so a
    // missing modelID/providerID must still yield the row — with the usage
    // fields parsed and the absent identifiers normalised to null.
    expect(rows).toHaveLength(1)
    expect(rows[0].model_id).toBeNull()
    expect(rows[0].provider_id).toBeNull()
    expect(rows[0].cost).toBeCloseTo(0.05, 6)
    expect(rows[0].input_tokens).toBe(100)
    expect(rows[0].output_tokens).toBe(50)
  })

  it("handles a missing (undefined) model/provider field gracefully", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant", cost: 0.07, tokens: { input: 7, output: 3 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(rows).not.toHaveProperty("error")
    if (!Array.isArray(rows)) throw new Error("expected rows array")

    expect(rows).toHaveLength(1)
    expect(rows[0].model_id).toBeNull()
    expect(rows[0].provider_id).toBeNull()
    expect(rows[0].cost).toBeCloseTo(0.07, 6)
    expect(rows[0].input_tokens).toBe(7)
    expect(rows[0].output_tokens).toBe(3)
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

// ─── Schema-aware layer: fixtures ────────────────────────────────────────────
//
// OpenCode 2.0.27 renamed the historical tables: `message` → `session_message`
// (with a `type` discriminator) and `session` → `session_v2`; assistant usage
// lives under `data.model.id` / `data.model.providerID` instead of
// `data.modelID` / `data.providerID`. The fixtures below build each generation
// and the hybrid a v1→v2 migration leaves behind.

type TestDb = { dbPath: string; cleanup: () => void }

const V2_DAY = 86_400_000
const V2_REFERENCE = Date.UTC(2026, 6, 6, 12, 0, 0)

const SESSION_TABLE_SQL = `(
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
)`

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Pure v2 DB: `session_message` + `session_v2` only (OpenCode 2.0.27). */
function setupV2Db(): TestDb {
  const dir = tempDir("opencode-test-v2-")
  const dbPath = join(dir, "test.db")
  const db = new Database(dbPath)
  try {
    db.run(`CREATE TABLE session_message (type TEXT, time_created INTEGER, data TEXT)`)
    db.run(`CREATE TABLE session_v2 ${SESSION_TABLE_SQL}`)
  } finally {
    db.close()
  }
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Hybrid DB: both v1 (`message`/`session`) and v2 (`session_message`/`session_v2`). */
function setupHybridDb(): TestDb {
  const dir = tempDir("opencode-test-hybrid-")
  const dbPath = join(dir, "test.db")
  const db = new Database(dbPath)
  try {
    db.run(`CREATE TABLE message (time_created INTEGER, data TEXT)`)
    db.run(`CREATE TABLE session ${SESSION_TABLE_SQL}`)
    db.run(`CREATE TABLE session_message (type TEXT, time_created INTEGER, data TEXT)`)
    db.run(`CREATE TABLE session_v2 ${SESSION_TABLE_SQL}`)
  } finally {
    db.close()
  }
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Create a DB from arbitrary DDL — used for unsupported/malformed schemas. */
function setupCustomDb(statements: string[]): TestDb {
  const dir = tempDir("opencode-test-custom-")
  const dbPath = join(dir, "test.db")
  const db = new Database(dbPath)
  try {
    for (const statement of statements) db.run(statement)
  } finally {
    db.close()
  }
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Usage payload shaped like an OpenCode 2.0.27 assistant message. */
function v2Data(
  modelID: string | null,
  providerID: string | null,
  cost: number,
  input: number,
  output: number,
): Record<string, unknown> {
  return { model: { id: modelID, providerID }, cost, tokens: { input, output } }
}

function insertV2Message(
  dbPath: string,
  timeCreated: number,
  type: string,
  data: Record<string, unknown>,
) {
  const db = new Database(dbPath)
  try {
    db.run(`INSERT INTO session_message (type, time_created, data) VALUES (?, ?, ?)`, [
      type,
      timeCreated,
      JSON.stringify(data),
    ])
  } finally {
    db.close()
  }
}

function insertV2Session(
  dbPath: string,
  id: string,
  parentId: string | null,
  timeCreated: number,
  overrides: Partial<{
    title: string
    cost: number
    tokensInput: number
    tokensOutput: number
  }> = {},
) {
  const db = new Database(dbPath)
  try {
    db.run(
      `INSERT INTO session_v2 (
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
        0,
        0,
        0,
        "",
        0,
      ],
    )
  } finally {
    db.close()
  }
}

/** Snapshot table names + row counts, for read-only (no-write) assertions. */
function snapshotDb(dbPath: string): { tables: string[]; counts: Record<string, number> } {
  const db = new Database(dbPath, { readonly: true })
  try {
    const tables = (
      db.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]
    ).map((r) => r.name)
    const counts: Record<string, number> = {}
    for (const table of tables) {
      counts[table] = (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
    }
    return { tables, counts }
  } finally {
    db.close()
  }
}

// ─── detectUsageSchema ───────────────────────────────────────────────────────

describe("detectUsageSchema", () => {
  let setup: TestDb

  afterEach(() => {
    setup?.cleanup()
  })

  it("classifies a pure v1 database", () => {
    setup = setupDb()
    const db = new Database(setup.dbPath, { readonly: true })
    try {
      const info: UsageSchemaInfo = detectUsageSchema(db)
      expect(info.kind).toBe("v1")
      expect(info.v1Message).toBe(true)
      expect(info.v1Session).toBe(true)
      expect(info.v2Message).toBe(false)
      expect(info.v2Session).toBe(false)
    } finally {
      db.close()
    }
  })

  it("classifies a pure v2 database (session_message / session_v2)", () => {
    setup = setupV2Db()
    const db = new Database(setup.dbPath, { readonly: true })
    try {
      const info = detectUsageSchema(db)
      expect(info.kind).toBe("v2")
      expect(info.v2Message).toBe(true)
      expect(info.v2Session).toBe(true)
      expect(info.v1Message).toBe(false)
      expect(info.v1Session).toBe(false)
    } finally {
      db.close()
    }
  })

  it("classifies a hybrid database", () => {
    setup = setupHybridDb()
    const db = new Database(setup.dbPath, { readonly: true })
    try {
      const info = detectUsageSchema(db)
      expect(info.kind).toBe("hybrid")
      expect(info.v1Message).toBe(true)
      expect(info.v1Session).toBe(true)
      expect(info.v2Message).toBe(true)
      expect(info.v2Session).toBe(true)
    } finally {
      db.close()
    }
  })

  it("classifies an empty/irrelevant database as unsupported", () => {
    setup = setupCustomDb([`CREATE TABLE unrelated (id INTEGER)`])
    const db = new Database(setup.dbPath, { readonly: true })
    try {
      const info = detectUsageSchema(db)
      expect(info.kind).toBe("unsupported")
      expect(info.v1Message).toBe(false)
      expect(info.v1Session).toBe(false)
      expect(info.v2Message).toBe(false)
      expect(info.v2Session).toBe(false)
    } finally {
      db.close()
    }
  })

  it("requires the v2 `type` discriminator (a table missing it is not v2)", () => {
    // session_message without `type` is not a usable v2 message table.
    setup = setupCustomDb([`CREATE TABLE session_message (time_created INTEGER, data TEXT)`])
    const db = new Database(setup.dbPath, { readonly: true })
    try {
      const info = detectUsageSchema(db)
      expect(info.v2Message).toBe(false)
      expect(info.kind).toBe("unsupported")
    } finally {
      db.close()
    }
  })

  it("requires a `data` column (a message table missing it is not v1)", () => {
    setup = setupCustomDb([`CREATE TABLE message (time_created INTEGER)`])
    const db = new Database(setup.dbPath, { readonly: true })
    try {
      const info = detectUsageSchema(db)
      expect(info.v1Message).toBe(false)
      expect(info.kind).toBe("unsupported")
    } finally {
      db.close()
    }
  })

  it("requires the full session shape (missing tokens_output is not a session table)", () => {
    setup = setupCustomDb([
      `CREATE TABLE session (id TEXT, parent_id TEXT, time_created INTEGER, title TEXT, cost REAL, tokens_input INTEGER)`,
    ])
    const db = new Database(setup.dbPath, { readonly: true })
    try {
      const info = detectUsageSchema(db)
      expect(info.v1Session).toBe(false)
      expect(info.kind).toBe("unsupported")
    } finally {
      db.close()
    }
  })

  it("is read-only: detecting never creates a table", () => {
    setup = setupV2Db()
    const before = snapshotDb(setup.dbPath)
    const db = new Database(setup.dbPath, { readonly: true })
    try {
      detectUsageSchema(db)
    } finally {
      db.close()
    }
    expect(snapshotDb(setup.dbPath)).toEqual(before)
  })
})

// ─── v1 ⇄ v2 output parity ───────────────────────────────────────────────────

describe("v1 ⇄ v2 output parity", () => {
  let v1: TestDb
  let v2: TestDb

  const RANGE_START = Date.UTC(2026, 6, 6, 0, 0, 0)
  const RANGE_END = RANGE_START + 2 * V2_DAY
  const MSG1 = RANGE_START + 1000
  const MSG2 = RANGE_START + V2_DAY + 1000

  function seedV1() {
    insertMessage(v1.dbPath, MSG1, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost: 0.05, tokens: { input: 100, output: 50 },
    })
    insertMessage(v1.dbPath, RANGE_START + 500, {
      role: "user", modelID: null, providerID: null,
      cost: 0, tokens: { input: 0, output: 0 },
    })
    insertMessage(v1.dbPath, MSG2, {
      role: "assistant", modelID: "claude-3", providerID: "anthropic",
      cost: 0.08, tokens: { input: 2000, output: 1000 },
    })
    insertSession(v1.dbPath, "root1", null, RANGE_START, {
      title: "one", cost: 0.5, tokensInput: 100, tokensOutput: 100,
    })
    insertSession(v1.dbPath, "root2", null, RANGE_START + 1000, {
      title: "two", cost: 0.9, tokensInput: 10, tokensOutput: 10,
    })
    insertSession(v1.dbPath, "sub1", "root1", RANGE_START + 10, { cost: 99 })
  }

  function seedV2() {
    insertV2Message(v2.dbPath, MSG1, "assistant", v2Data("gpt-4", "copilot", 0.05, 100, 50))
    insertV2Message(v2.dbPath, RANGE_START + 500, "user", {})
    insertV2Message(v2.dbPath, MSG2, "assistant", v2Data("claude-3", "anthropic", 0.08, 2000, 1000))
    insertV2Session(v2.dbPath, "root1", null, RANGE_START, {
      title: "one", cost: 0.5, tokensInput: 100, tokensOutput: 100,
    })
    insertV2Session(v2.dbPath, "root2", null, RANGE_START + 1000, {
      title: "two", cost: 0.9, tokensInput: 10, tokensOutput: 10,
    })
    insertV2Session(v2.dbPath, "sub1", "root1", RANGE_START + 10, { cost: 99 })
  }

  beforeEach(() => {
    v1 = setupDb()
    v2 = setupV2Db()
    seedV1()
    seedV2()
  })

  afterEach(() => {
    v1.cleanup()
    v2.cleanup()
  })

  it("queryUsage produces identical model/token/cost output", () => {
    expect(queryUsage(v2.dbPath, RANGE_START, RANGE_END)).toEqual(
      queryUsage(v1.dbPath, RANGE_START, RANGE_END),
    )
  })

  it("v2 usage reads data.model.id / data.model.providerID / cost / tokens", () => {
    const usage = queryUsage(v2.dbPath, RANGE_START, RANGE_END)
    if ("error" in usage) throw new Error("expected usage result")
    expect(usage.totalInput).toBe(2100)
    expect(usage.totalOutput).toBe(1050)
    expect(usage.totalCost).toBeCloseTo(0.13, 6)
    const gpt = usage.models.find((m) => m.modelID === "gpt-4")
    expect(gpt).toEqual({
      providerID: "copilot",
      modelID: "gpt-4",
      totalCost: 0.05,
      totalInput: 100,
      totalOutput: 50,
    })
  })

  it("fetchRawRows produces identical rows (fields + order + time)", () => {
    expect(fetchRawRows(v2.dbPath, RANGE_START, RANGE_END)).toEqual(
      fetchRawRows(v1.dbPath, RANGE_START, RANGE_END),
    )
  })

  it("v2 raw rows carry time_created and model/provider/token/cost fields", () => {
    const rows = fetchRawRows(v2.dbPath, RANGE_START, RANGE_END) as RawUsageRow[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      time_created: MSG1,
      model_id: "gpt-4",
      provider_id: "copilot",
      input_tokens: 100,
      output_tokens: 50,
    })
    expect(rows[0].cost).toBeCloseTo(0.05, 6)
  })

  it("queryDailyTotals produces identical per-day buckets", () => {
    expect(queryDailyTotals(v2.dbPath, RANGE_START, RANGE_END)).toEqual(
      queryDailyTotals(v1.dbPath, RANGE_START, RANGE_END),
    )
  })

  it("getEarliestUsageDate returns the same earliest assistant timestamp", () => {
    expect(getEarliestUsageDate(v2.dbPath)).toBe(getEarliestUsageDate(v1.dbPath))
    expect(getEarliestUsageDate(v2.dbPath)).toBe(MSG1)
  })

  it("queryTopSessions (cost & tokens) produces the same leaderboard", () => {
    expect(queryTopSessions(v2.dbPath, RANGE_START, RANGE_END, "cost")).toEqual(
      queryTopSessions(v1.dbPath, RANGE_START, RANGE_END, "cost"),
    )
    expect(queryTopSessions(v2.dbPath, RANGE_START, RANGE_END, "tokens")).toEqual(
      queryTopSessions(v1.dbPath, RANGE_START, RANGE_END, "tokens"),
    )
  })

  it("v2 leaderboard counts subagents and excludes them from roots", () => {
    const result = queryTopSessions(v2.dbPath, RANGE_START, RANGE_END, "cost")
    if ("error" in result) throw new Error("expected sessions result")
    expect(result.sessions.map((s) => s.id).sort()).toEqual(["root1", "root2"])
    expect(result.sessions.find((s) => s.id === "root1")?.subagentCount).toBe(1)
  })

  it("fetchRootSessionTimestamps produces identical root timestamps", () => {
    const v2Timestamps = fetchRootSessionTimestamps(v2.dbPath, RANGE_START, RANGE_END)
    const v1Timestamps = fetchRootSessionTimestamps(v1.dbPath, RANGE_START, RANGE_END)
    expect(v2Timestamps).toEqual(v1Timestamps)
    expect(v2Timestamps).toEqual([RANGE_START, RANGE_START + 1000])
  })

  it("v2 excludes non-assistant `type` rows (user/system)", () => {
    insertV2Message(v2.dbPath, RANGE_START + 2000, "user", v2Data("x", "y", 999, 9999, 9999))
    insertV2Message(v2.dbPath, RANGE_START + 3000, "system", v2Data("x", "y", 999, 9999, 9999))
    const rows = fetchRawRows(v2.dbPath, RANGE_START, RANGE_END) as RawUsageRow[]
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.cost < 999)).toBe(true)
  })

  it("v1-shaped JSON in a v2 table is ignored (no data.modelID fallback)", () => {
    insertV2Message(v2.dbPath, RANGE_START + 4000, "assistant", {
      modelID: "legacy-model", providerID: "legacy-provider",
      cost: 5, tokens: { input: 9, output: 9 },
    })
    const rows = fetchRawRows(v2.dbPath, RANGE_START, RANGE_END) as RawUsageRow[]
    expect(rows.some((r) => r.model_id === "legacy-model")).toBe(false)
  })
})

// ─── Hybrid source selection ─────────────────────────────────────────────────

describe("hybrid schema source selection", () => {
  let setup: TestDb

  const RANGE_START = Date.UTC(2026, 6, 6, 0, 0, 0)
  const RANGE_END = RANGE_START + V2_DAY

  afterEach(() => {
    setup?.cleanup()
  })

  function assistantV1(dbPath: string, t: number, cost: number, input: number, output: number) {
    insertMessage(dbPath, t, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost, tokens: { input, output },
    })
  }

  function assistantV2(dbPath: string, t: number, cost: number, input: number, output: number) {
    insertV2Message(dbPath, t, "assistant", v2Data("gpt-4", "copilot", cost, input, output))
  }

  it("prefers v2 when it has the newest dataset and does not double count v1", () => {
    setup = setupHybridDb()
    assistantV1(setup.dbPath, RANGE_START, 0.11, 100, 50)
    assistantV2(setup.dbPath, RANGE_START + 1000, 0.22, 10, 5)

    const rows = fetchRawRows(setup.dbPath, RANGE_START, RANGE_END) as RawUsageRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0].cost).toBeCloseTo(0.22, 6)

    const usage = queryUsage(setup.dbPath, RANGE_START, RANGE_END)
    if ("error" in usage) throw new Error("expected usage result")
    expect(usage.totalCost).toBeCloseTo(0.22, 6)
    expect(usage.totalInput).toBe(10)
  })

  it("prefers v1 when v1 has the newest dataset", () => {
    setup = setupHybridDb()
    assistantV1(setup.dbPath, RANGE_START + 1000, 0.33, 300, 300)
    assistantV2(setup.dbPath, RANGE_START, 0.44, 4, 4)

    const rows = fetchRawRows(setup.dbPath, RANGE_START, RANGE_END) as RawUsageRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0].cost).toBeCloseTo(0.33, 6)
  })

  it("prefers v2 on a timestamp tie", () => {
    setup = setupHybridDb()
    assistantV1(setup.dbPath, RANGE_START, 0.11, 1, 1)
    assistantV2(setup.dbPath, RANGE_START, 0.22, 2, 2)

    const rows = fetchRawRows(setup.dbPath, RANGE_START, RANGE_END) as RawUsageRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0].cost).toBeCloseTo(0.22, 6)
  })

  it("falls back to legacy v1 when the v2 table has no rows", () => {
    setup = setupHybridDb()
    assistantV1(setup.dbPath, RANGE_START, 0.55, 55, 55)

    const rows = fetchRawRows(setup.dbPath, RANGE_START, RANGE_END) as RawUsageRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0].cost).toBeCloseTo(0.55, 6)

    const usage = queryUsage(setup.dbPath, RANGE_START, RANGE_END)
    if ("error" in usage) throw new Error("expected usage result")
    expect(usage.totalCost).toBeCloseTo(0.55, 6)
    expect(usage.totalInput).toBe(55)
  })

  it("falls back to legacy v1 when v2 exists but has no rows in the window", () => {
    setup = setupHybridDb()
    assistantV1(setup.dbPath, RANGE_START, 0.66, 66, 66)
    // v2 is globally newest (makes it primary) but lies outside the query window.
    assistantV2(setup.dbPath, RANGE_START + 10 * V2_DAY, 0.99, 99, 99)

    const rows = fetchRawRows(setup.dbPath, RANGE_START, RANGE_END) as RawUsageRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0].cost).toBeCloseTo(0.66, 6)

    const daily = queryDailyTotals(setup.dbPath, RANGE_START, RANGE_END)
    expect(daily).not.toHaveProperty("error")
    const totals = daily as { input_tokens: number }[]
    expect(totals).toHaveLength(1)
    expect(totals[0].input_tokens).toBe(66)
  })

  it("daily totals are never summed across datasets (no double count)", () => {
    setup = setupHybridDb()
    assistantV1(setup.dbPath, RANGE_START, 0.11, 100, 100)
    assistantV2(setup.dbPath, RANGE_START + 1000, 0.22, 10, 10)

    const daily = queryDailyTotals(setup.dbPath, RANGE_START, RANGE_END)
    if ("error" in daily) throw new Error("expected daily totals")
    expect(daily).toHaveLength(1)
    expect(daily[0].input_tokens).toBe(10)
    expect(daily[0].cost).toBeCloseTo(0.22, 6)
  })

  it("session leaderboard falls back to v1 when session_v2 is empty", () => {
    setup = setupHybridDb()
    insertSession(setup.dbPath, "legacy-root", null, RANGE_START, {
      title: "legacy", cost: 1.5, tokensInput: 10, tokensOutput: 20,
    })

    const result = queryTopSessions(setup.dbPath, RANGE_START, RANGE_END, "cost")
    if ("error" in result) throw new Error("expected sessions result")
    expect(result.sessions.map((s) => s.id)).toEqual(["legacy-root"])

    const timestamps = fetchRootSessionTimestamps(setup.dbPath, RANGE_START, RANGE_END)
    expect(timestamps).toEqual([RANGE_START])
  })

  it("session leaderboard prefers v2 when both session tables have rows", () => {
    setup = setupHybridDb()
    insertSession(setup.dbPath, "v1-root", null, RANGE_START, { cost: 0.1 })
    insertV2Session(setup.dbPath, "v2-root", null, RANGE_START + 1000, { cost: 0.2 })

    const result = queryTopSessions(setup.dbPath, RANGE_START, RANGE_END, "cost")
    if ("error" in result) throw new Error("expected sessions result")
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0].id).toBe("v2-root")
    expect(result.sessions[0].cost).toBeCloseTo(0.2, 6)
  })

  it("getEarliestUsageDate prefers the active dataset", () => {
    setup = setupHybridDb()
    assistantV1(setup.dbPath, RANGE_START + 500, 0.1, 1, 1)
    assistantV2(setup.dbPath, RANGE_START + 2000, 0.2, 2, 2)
    // v2 is newest → its MIN(time_created) is the v2 row.
    expect(getEarliestUsageDate(setup.dbPath)).toBe(RANGE_START + 2000)
  })
})

// ─── Unsupported / malformed schema ──────────────────────────────────────────

describe("unsupported and malformed schemas", () => {
  let setup: TestDb

  const START = 0
  const END = Date.UTC(2026, 6, 7)

  afterEach(() => {
    setup?.cleanup()
  })

  it("empty/irrelevant DB returns graceful empties from every query", () => {
    setup = setupCustomDb([`CREATE TABLE unrelated (id INTEGER)`])

    const usage = queryUsage(setup.dbPath, START, END)
    expect(usage).toEqual({ models: [], totalInput: 0, totalOutput: 0, totalCost: 0 })

    expect(fetchRawRows(setup.dbPath, START, END)).toEqual([])
    expect(queryDailyTotals(setup.dbPath, START, END)).toEqual([])
    expect(getEarliestUsageDate(setup.dbPath)).toBeNull()

    const sessions = queryTopSessions(setup.dbPath, START, END, "cost")
    expect(sessions).toEqual({ sessions: [] })
    expect(fetchRootSessionTimestamps(setup.dbPath, START, END)).toEqual([])
  })

  it("malformed v2 (session_message without `type`) degrades instead of erroring", () => {
    setup = setupCustomDb([
      `CREATE TABLE session_message (time_created INTEGER, data TEXT)`,
      `INSERT INTO session_message (time_created, data) VALUES (1000, '{"model":{"id":"x","providerID":"y"}}')`,
    ])

    const usage = queryUsage(setup.dbPath, START, END)
    expect(usage).toEqual({ models: [], totalInput: 0, totalOutput: 0, totalCost: 0 })
    expect(fetchRawRows(setup.dbPath, START, END)).toEqual([])
    expect(getEarliestUsageDate(setup.dbPath)).toBeNull()
    expect(queryTopSessions(setup.dbPath, START, END, "cost")).toEqual({ sessions: [] })
  })

  it("malformed v1 (message without `data`) degrades instead of erroring", () => {
    setup = setupCustomDb([`CREATE TABLE message (time_created INTEGER)`])

    expect(fetchRawRows(setup.dbPath, START, END)).toEqual([])
    expect(queryDailyTotals(setup.dbPath, START, END)).toEqual([])
    expect(getEarliestUsageDate(setup.dbPath)).toBeNull()
  })

  it("a malformed table is ignored while a well-formed sibling still works", () => {
    setup = setupCustomDb([
      `CREATE TABLE session_message (time_created INTEGER, data TEXT)`,
      `CREATE TABLE session_v2 (id TEXT, parent_id TEXT, time_created INTEGER, title TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER)`,
      `INSERT INTO session_v2 (id, parent_id, time_created, title, cost, tokens_input, tokens_output) VALUES ('r', NULL, 1000, 't', 0.5, 10, 20)`,
    ])

    // v2Session is well-formed → the leaderboard works; v2Message is ignored.
    const result = queryTopSessions(setup.dbPath, START, END, "cost")
    if ("error" in result) throw new Error("expected sessions result")
    expect(result.sessions.map((s) => s.id)).toEqual(["r"])
    expect(fetchRawRows(setup.dbPath, START, END)).toEqual([])
  })

  it("non-assistant-only v2 data returns an empty usage result", () => {
    setup = setupV2Db()
    insertV2Message(setup.dbPath, 1000, "user", v2Data("m", "p", 1, 10, 10))
    insertV2Message(setup.dbPath, 2000, "system", v2Data("m", "p", 1, 10, 10))

    expect(queryUsage(setup.dbPath, START, END)).toEqual({
      models: [], totalInput: 0, totalOutput: 0, totalCost: 0,
    })
    expect(fetchRawRows(setup.dbPath, START, END)).toEqual([])
  })
})

// ─── Read-only guarantees ────────────────────────────────────────────────────

describe("read-only guarantees", () => {
  let setup: TestDb

  const START = 0
  const END = Date.UTC(2026, 6, 7)

  beforeEach(() => {
    setup = setupDb()
    insertMessage(setup.dbPath, 1000, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost: 0.05, tokens: { input: 100, output: 50 },
    })
    insertSession(setup.dbPath, "root", null, 500, { cost: 0.5, tokensInput: 10, tokensOutput: 10 })
  })

  afterEach(() => {
    setup.cleanup()
  })

  it("path-based queries never write (schema and row counts unchanged)", () => {
    const before = snapshotDb(setup.dbPath)
    fetchRawRows(setup.dbPath, START, END)
    queryUsage(setup.dbPath, START, END)
    queryDailyTotals(setup.dbPath, START, END)
    queryTopSessions(setup.dbPath, START, END, "cost")
    fetchRootSessionTimestamps(setup.dbPath, START, END)
    getEarliestUsageDate(setup.dbPath)
    expect(snapshotDb(setup.dbPath)).toEqual(before)
  })

  it("accepts an already-open handle and leaves it open and unmodified", () => {
    const db = new Database(setup.dbPath)
    try {
      const usage = queryUsage(db, START, END)
      if ("error" in usage) throw new Error("expected usage result")
      expect(usage.totalInput).toBe(100)

      // The caller-owned handle must survive the call (ownConnection === false).
      expect(db.query(`SELECT COUNT(*) AS c FROM message`).get()).toEqual({ c: 1 })
      expect(db.query(`SELECT 1 AS x`).get()).toEqual({ x: 1 })
    } finally {
      db.close()
    }
  })

  it("is idempotent: repeated reads return the same result", () => {
    const first = fetchRawRows(setup.dbPath, START, END)
    const second = fetchRawRows(setup.dbPath, START, END)
    expect(second).toEqual(first)
  })
})
