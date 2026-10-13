import { Database } from "bun:sqlite"
import type { ModelUsage, UsageRow, UsageData } from "./types"
import { log, DEBUG } from "./helpers/debug"

export interface RawUsageRow {
  time_created: number
  model_id: string | null
  provider_id: string | null
  cost: number
  input_tokens: number
  output_tokens: number
}

export const MAX_MODELS = 10

export interface PeriodStats {
  sessions: number
  messages: number
}

export interface TopSession {
  id: string
  title: string | null
  cost: number
  tokensInput: number
  tokensOutput: number
  tokens: number
  subagentCount: number
  timeCreated: number
}

// ─── Schema-aware historical query layer ─────────────────────────────────────
//
// OpenCode ships two database generations that both back `/usage`:
//
//   • v1 — `message` + `session`: assistant messages carry usage in
//     `data.modelID`, `data.providerID`, `data.cost`, `data.tokens.input|output`.
//   • v2 — `session_message` + `session_v2` (OpenCode 2.0.27): an assistant
//     message is `type = 'assistant'` and carries usage in `data.model.id`,
//     `data.model.providerID`, `data.cost`, `data.tokens.input|output`.
//
// A database may be pure v1, pure v2, or hybrid (both — e.g. after a v1→v2
// migration leaves the old tables in place). Detection is table/column based
// (`pragma_table_info` — a read, never DDL or a write), and each query picks
// the *newest* usage dataset as primary, falling back to the other only when
// the primary has no relevant rows. This keeps a hybrid DB from being
// double-counted, and lets a v2-only install work without touching v1 code.
//
// Missing / unrecognised tables degrade to empty results rather than surfacing
// a raw SQLite `no such table` error in the UI. All access stays read-only.

type Source = "v1" | "v2"

/** Which generation(s) of the OpenCode historical schema a database exposes. */
export type UsageSchemaKind = "v1" | "v2" | "hybrid" | "unsupported"

export interface UsageSchemaInfo {
  readonly kind: UsageSchemaKind
  readonly v1Message: boolean
  readonly v1Session: boolean
  readonly v2Message: boolean
  readonly v2Session: boolean
}

const V1_MESSAGE_COLUMNS = ["time_created", "data"] as const
const V2_MESSAGE_COLUMNS = ["type", "time_created", "data"] as const
const SESSION_COLUMNS = [
  "id",
  "parent_id",
  "time_created",
  "title",
  "cost",
  "tokens_input",
  "tokens_output",
] as const

/**
 * Whether `table` exists and exposes every column in `required`.
 *
 * `pragma_table_info` is a table-valued function that yields zero rows for a
 * missing table, so a single read both detects existence and validates the
 * shape. Never throws.
 */
function hasColumns(db: Database, table: string, required: readonly string[]): boolean {
  try {
    const rows = db.query(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
    if (!rows || rows.length === 0) return false
    const present = new Set(rows.map((r) => r.name))
    return required.every((c) => present.has(c))
  } catch {
    return false
  }
}

/**
 * Inspect an open database and classify its historical usage schema. Read-only:
 * only `pragma_table_info` lookups, no DDL.
 */
export function detectUsageSchema(db: Database): UsageSchemaInfo {
  const v1Message = hasColumns(db, "message", V1_MESSAGE_COLUMNS)
  const v1Session = hasColumns(db, "session", SESSION_COLUMNS)
  const v2Message = hasColumns(db, "session_message", V2_MESSAGE_COLUMNS)
  const v2Session = hasColumns(db, "session_v2", SESSION_COLUMNS)
  const anyV1 = v1Message || v1Session
  const anyV2 = v2Message || v2Session
  const kind: UsageSchemaKind = anyV1 && anyV2 ? "hybrid" : anyV2 ? "v2" : anyV1 ? "v1" : "unsupported"
  return { kind, v1Message, v1Session, v2Message, v2Session }
}

function maxTimeCreated(db: Database, table: string): number | null {
  try {
    const row = db.query(`SELECT MAX(time_created) AS m FROM ${table}`).get() as { m: number | null } | undefined
    return row?.m ?? null
  } catch {
    return null
  }
}

/**
 * Candidate sources for a table family, newest usage dataset first.
 *
 * When both generations are present the one with the later `MAX(time_created)`
 * is the active/newer dataset and is tried first; ties prefer v2. The second
 * entry is a pure fallback — it is only read when the primary yields no rows in
 * the requested window, so the two datasets are never summed together.
 */
function orderSources(
  db: Database,
  v1Available: boolean,
  v2Available: boolean,
  v1Table: string,
  v2Table: string,
): Source[] {
  const sources: Source[] = []
  if (v1Available) sources.push("v1")
  if (v2Available) sources.push("v2")
  if (sources.length <= 1) return sources

  const v1Max = maxTimeCreated(db, v1Table)
  const v2Max = maxTimeCreated(db, v2Table)
  return v2Max !== null && (v1Max === null || v2Max >= v1Max) ? ["v2", "v1"] : ["v1", "v2"]
}

function messageSources(db: Database, schema: UsageSchemaInfo): Source[] {
  return orderSources(db, schema.v1Message, schema.v2Message, "message", "session_message")
}

function sessionSources(db: Database, schema: UsageSchemaInfo): Source[] {
  return orderSources(db, schema.v1Session, schema.v2Session, "session", "session_v2")
}

/**
 * Run `buildSql(source)` over each candidate source and return the first
 * non-empty result. A source that errors (e.g. a table dropped mid-flight) is
 * skipped, so an unsupported schema degrades to an empty array.
 */
function firstNonEmpty<T>(
  db: Database,
  sources: Source[],
  buildSql: (source: Source) => string,
  params: readonly (number | string)[],
): T[] {
  for (const source of sources) {
    try {
      const rows = db.query(buildSql(source)).all(...params) as T[]
      if (rows && rows.length > 0) return rows
    } catch {
      // Unsupported/missing table for this source → try the next candidate.
    }
  }
  return []
}

/** Open a path read-only, or reuse an already-open handle. */
function openDb(dbOrPath: Database | string): { db: Database; ownConnection: boolean } {
  if (typeof dbOrPath === "string") {
    return { db: new Database(dbOrPath, { readonly: true }), ownConnection: true }
  }
  return { db: dbOrPath, ownConnection: false }
}

function closeDb(db: Database | null, ownConnection: boolean): void {
  if (ownConnection) {
    try { db?.close() } catch { /* already closed */ }
  }
}

// ─── SQL builders ────────────────────────────────────────────────────────────

function groupedUsageSql(source: Source): string {
  if (source === "v2") {
    return `SELECT
       json_extract(data, '$.model.id')                            AS model_id,
       json_extract(data, '$.model.providerID')                    AS provider_id,
       SUM(CAST(json_extract(data, '$.cost') AS REAL))             AS total_cost,
       SUM(CAST(json_extract(data, '$.tokens.input')  AS INTEGER)) AS total_input,
       SUM(CAST(json_extract(data, '$.tokens.output') AS INTEGER)) AS total_output
     FROM session_message
     WHERE type = 'assistant'
       AND time_created >= ?
       AND time_created <  ?
     GROUP BY provider_id, model_id
     ORDER BY (total_input + total_output) DESC
     LIMIT ${MAX_MODELS}`
  }
  return `SELECT
       json_extract(data, '$.modelID')                            AS model_id,
       json_extract(data, '$.providerID')                         AS provider_id,
       SUM(CAST(json_extract(data, '$.cost') AS REAL))            AS total_cost,
       SUM(CAST(json_extract(data, '$.tokens.input')  AS INTEGER)) AS total_input,
       SUM(CAST(json_extract(data, '$.tokens.output') AS INTEGER)) AS total_output
     FROM message
     WHERE json_extract(data, '$.role') = 'assistant'
       AND time_created >= ?
       AND time_created <  ?
     GROUP BY provider_id, model_id
     ORDER BY (total_input + total_output) DESC
     LIMIT ${MAX_MODELS}`
}

function rawRowsSql(source: Source): string {
  if (source === "v2") {
    return `SELECT
       time_created,
       json_extract(data, '$.model.id')            AS model_id,
       json_extract(data, '$.model.providerID')    AS provider_id,
       CAST(json_extract(data, '$.cost') AS REAL)  AS cost,
       CAST(json_extract(data, '$.tokens.input')  AS INTEGER) AS input_tokens,
       CAST(json_extract(data, '$.tokens.output') AS INTEGER) AS output_tokens
     FROM session_message
     WHERE type = 'assistant'
       AND time_created >= ?
       AND time_created < ?
     ORDER BY time_created ASC`
  }
  return `SELECT
       time_created,
       json_extract(data, '$.modelID')             AS model_id,
       json_extract(data, '$.providerID')          AS provider_id,
       CAST(json_extract(data, '$.cost') AS REAL)  AS cost,
       CAST(json_extract(data, '$.tokens.input')  AS INTEGER) AS input_tokens,
       CAST(json_extract(data, '$.tokens.output') AS INTEGER) AS output_tokens
     FROM message
     WHERE json_extract(data, '$.role') = 'assistant'
       AND time_created >= ?
       AND time_created < ?
     ORDER BY time_created ASC`
}

function dailyTotalsSql(source: Source): string {
  if (source === "v2") {
    return `SELECT
       (time_created / 86400000) * 86400000 AS day_start,
       SUM(CAST(json_extract(data,'$.tokens.input')  AS INTEGER)) AS input_tokens,
       SUM(CAST(json_extract(data,'$.tokens.output') AS INTEGER)) AS output_tokens,
       SUM(CAST(json_extract(data,'$.cost') AS REAL)) AS cost
     FROM session_message
     WHERE type = 'assistant'
       AND time_created >= ? AND time_created < ?
     GROUP BY day_start
     ORDER BY day_start ASC`
  }
  return `SELECT
       (time_created / 86400000) * 86400000 AS day_start,
       SUM(CAST(json_extract(data,'$.tokens.input')  AS INTEGER)) AS input_tokens,
       SUM(CAST(json_extract(data,'$.tokens.output') AS INTEGER)) AS output_tokens,
       SUM(CAST(json_extract(data,'$.cost') AS REAL)) AS cost
     FROM message
     WHERE json_extract(data,'$.role') = 'assistant'
       AND time_created >= ? AND time_created < ?
     GROUP BY day_start
     ORDER BY day_start ASC`
}

function earliestUsageSql(source: Source): string {
  if (source === "v2") {
    return `SELECT MIN(time_created) AS earliest FROM session_message WHERE type = 'assistant'`
  }
  return `SELECT MIN(time_created) AS earliest FROM message WHERE json_extract(data, '$.role') = 'assistant'`
}

function topSessionsSql(source: Source, orderBy: string): string {
  const table = source === "v2" ? "session_v2" : "session"
  return `SELECT
       s.id,
       s.title,
       s.cost,
       s.tokens_input  AS tokensInput,
       s.tokens_output AS tokensOutput,
       (s.tokens_input + s.tokens_output) AS tokens,
       (SELECT COUNT(*) FROM ${table} c WHERE c.parent_id = s.id) AS subagentCount,
       s.time_created AS timeCreated
     FROM ${table} s
     WHERE s.parent_id IS NULL
       AND s.time_created >= ?
       AND s.time_created < ?
     ORDER BY ${orderBy} DESC
     LIMIT 10`
}

function rootSessionTimestampsSql(source: Source): string {
  const table = source === "v2" ? "session_v2" : "session"
  return `SELECT time_created FROM ${table} WHERE parent_id IS NULL AND time_created >= ? AND time_created < ?`
}

/**
 * Returns the top root sessions within the half-open range `[startMs, endMs)`,
 * ordered by either total cost or total tokens and limited to 10.
 *
 * Each row is a root session (`parent_id IS NULL`) with its subagent count
 * computed via a correlated subquery over its children. The session table is
 * schema-aware: v1 `session` or v2 `session_v2` (see the schema notes above);
 * a database with neither returns an empty leaderboard rather than an error.
 *
 * @param dbOrPath - an already-open Database instance, or a filesystem path to
 *   open a read-only connection (closed automatically on exit).
 * @param startMs - inclusive start of the range as a ms-epoch.
 * @param endMs - exclusive end of the range as a ms-epoch.
 * @param sort - ordering key: "cost" orders by `cost DESC`, "tokens" orders by
 *   `(tokens_input + tokens_output) DESC`.
 * @returns `{ sessions: TopSession[] }` on success, or `{ error: string }` on
 *   failure.
 */
export function queryTopSessions(
  dbOrPath: Database | string,
  startMs: number,
  endMs: number,
  sort: "cost" | "tokens",
): { sessions: TopSession[] } | { error: string } {
  let db: Database | null = null
  let ownConnection = false
  try {
    const conn = openDb(dbOrPath)
    db = conn.db
    ownConnection = conn.ownConnection

    const orderBy = sort === "cost" ? "s.cost" : "(s.tokens_input + s.tokens_output)"
    const schema = detectUsageSchema(db)
    const rows = firstNonEmpty<TopSession>(
      db,
      sessionSources(db, schema),
      (source) => topSessionsSql(source, orderBy),
      [startMs, endMs],
    )

    const sessions: TopSession[] = (rows ?? []).map((r: TopSession) => ({
      id: r.id,
      title: r.title ?? null,
      cost: r.cost ?? 0,
      tokensInput: r.tokensInput ?? 0,
      tokensOutput: r.tokensOutput ?? 0,
      tokens: r.tokens ?? 0,
      subagentCount: r.subagentCount ?? 0,
      timeCreated: r.timeCreated,
    }))

    return { sessions }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    closeDb(db, ownConnection)
  }
}

export function fetchRootSessionTimestamps(dbOrPath: Database | string, startMs: number, endMs: number): number[] | { error: string } {
  let db: Database | null = null
  let ownConnection = false
  try {
    const conn = openDb(dbOrPath)
    db = conn.db
    ownConnection = conn.ownConnection

    const schema = detectUsageSchema(db)
    const rows = firstNonEmpty<{ time_created: number }>(
      db,
      sessionSources(db, schema),
      rootSessionTimestampsSql,
      [startMs, endMs],
    )

    return (rows ?? []).map((r) => r.time_created)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    closeDb(db, ownConnection)
  }
}

export function queryUsage(dbOrPath: Database | string, startMs: number, endMs: number): UsageData | { error: string } {
  let db: Database | null = null
  let ownConnection = false
  try {
    const conn = openDb(dbOrPath)
    db = conn.db
    ownConnection = conn.ownConnection

    const schema = detectUsageSchema(db)
    const rows = firstNonEmpty<UsageRow>(
      db,
      messageSources(db, schema),
      groupedUsageSql,
      [startMs, endMs],
    )

    let totalInput = 0
    let totalOutput = 0
    let totalCost = 0

    const models: ModelUsage[] = (rows ?? [])
      .filter((r: UsageRow) => r.provider_id && r.model_id)
      .map((r: UsageRow) => {
        const inp = Math.max(0, r.total_input ?? 0)
        const out = Math.max(0, r.total_output ?? 0)
        const cost = Math.max(0, r.total_cost ?? 0)
        totalInput += inp
        totalOutput += out
        totalCost += cost
        return {
          providerID: r.provider_id,
          modelID: r.model_id,
          totalCost: cost,
          totalInput: inp,
          totalOutput: out,
        }
      })

    return { models, totalInput, totalOutput, totalCost }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    closeDb(db, ownConnection)
  }
}

export function fetchRawRows(dbOrPath: Database | string, startMs: number, endMs: number): RawUsageRow[] | { error: string } {
  let db: Database | null = null
  let ownConnection = false
  try {
    const conn = openDb(dbOrPath)
    db = conn.db
    ownConnection = conn.ownConnection

    const schema = detectUsageSchema(db)
    const rows = firstNonEmpty<RawUsageRow>(
      db,
      messageSources(db, schema),
      rawRowsSql,
      [startMs, endMs],
    )

    return (rows ?? []).map((r: RawUsageRow) => ({
      time_created: r.time_created,
      model_id: r.model_id ?? null,
      provider_id: r.provider_id ?? null,
      cost: r.cost ?? 0,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
    }))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    closeDb(db, ownConnection)
  }
}

export interface DailyTotal {
  day_start: number
  input_tokens: number
  output_tokens: number
  cost: number
}

/**
 * Aggregates assistant message token usage and cost per calendar day over the
 * half-open range `[startMs, endMs)`.
 *
 * Each returned row represents one day, keyed by `day_start` (a non-negative
 * ms-epoch truncated to the start of its UTC day, i.e. `Math.floor(t / MS_PER_DAY) * MS_PER_DAY`).
 * `input_tokens`, `output_tokens`, and `cost` are summed per day via a single
 * SQL `GROUP BY` over the day expression. Schema-aware across v1 `message` and
 * v2 `session_message` (see the schema notes above).
 *
 * @param dbOrPath - an already-open Database instance, or a filesystem path to
 *   open a read-only connection (closed automatically on exit).
 * @param startMs - inclusive start of the range as a ms-epoch.
 * @param endMs - exclusive end of the range as a ms-epoch.
 * @returns an array of `DailyTotal` rows ordered by `day_start` ascending, or
 *   `{ error: string }` if the query fails.
 */
export function queryDailyTotals(
  dbOrPath: Database | string,
  startMs: number,
  endMs: number,
): DailyTotal[] | { error: string } {
  let db: Database | null = null
  let ownConnection = false
  try {
    const conn = openDb(dbOrPath)
    db = conn.db
    ownConnection = conn.ownConnection

    const schema = detectUsageSchema(db)
    const rows = firstNonEmpty<DailyTotal>(
      db,
      messageSources(db, schema),
      dailyTotalsSql,
      [startMs, endMs],
    )

    return (rows ?? []).map((r: DailyTotal) => ({
      day_start: r.day_start,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
      cost: r.cost ?? 0,
    }))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    closeDb(db, ownConnection)
  }
}

export function getEarliestUsageDate(dbOrPath: Database | string): number | null {
  let db: Database | null = null
  let ownConnection = false
  try {
    const conn = openDb(dbOrPath)
    db = conn.db
    ownConnection = conn.ownConnection

    const schema = detectUsageSchema(db)
    for (const source of messageSources(db, schema)) {
      try {
        const row = db.query(earliestUsageSql(source)).get() as { earliest: number | null } | undefined
        if (row?.earliest != null) return row.earliest
      } catch {
        // Unsupported/missing table for this source → try the next candidate.
      }
    }
    return null
  } catch {
    return null
  } finally {
    closeDb(db, ownConnection)
  }
}

/**
 * Tier 1 system-token source: read the full assembled system baseline that the
 * V2 native runner persists to `session_context_epoch.baseline` on every turn
 * (written by `packages/core/src/session/context-epoch.ts`). Returns the raw
 * baseline string, or `null` if the table is empty for this session (V1 / AI
 * SDK path) or the table does not exist.
 *
 * The caller is responsible for tokenising the returned text (char/4).
 */
export function loadBaseline(dbOrPath: Database | string, sessionID: string): string | null {
  let db: Database | null = null
  let ownConnection = false
  try {
    const conn = openDb(dbOrPath)
    db = conn.db
    ownConnection = conn.ownConnection
    // Guard against older OpenCode builds that lack the table.
    const table = db
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='session_context_epoch'`)
      .get() as { name: string } | undefined
    if (!table) return null
    log("loadBaseline: session_context_epoch table exists, checking for session", sessionID)
    const row = db
      .query(`SELECT baseline FROM session_context_epoch WHERE session_id = ?`)
      .get(sessionID) as { baseline: string } | undefined
    log("loadBaseline: query result for session", sessionID, ":", row ? `baseline length=${row.baseline.length}` : "NOT FOUND")
    if (DEBUG) {
      try {
        const sessionRow = db.query(`SELECT version FROM session WHERE id = ?`).get(sessionID) as { version: string } | undefined
        log("loadBaseline: session version:", sessionRow?.version ?? "UNKNOWN")
      } catch { /* ignore */ }
      try {
        const countRow = db.query(`SELECT count(*) as c FROM session_context_epoch`).get() as { c: number } | undefined
        log("loadBaseline: total session_context_epoch rows:", countRow?.c ?? 0)
      } catch { /* ignore */ }
    }
    if (!row || typeof row.baseline !== "string" || row.baseline.length === 0) return null
    return row.baseline
  } catch {
    return null
  } finally {
    closeDb(db, ownConnection)
  }
}
