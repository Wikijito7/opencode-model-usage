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

/**
 * Returns the top root sessions within the half-open range `[startMs, endMs)`,
 * ordered by either total cost or total tokens and limited to 10.
 *
 * Only the `session` table is queried (no message/json_extract scans). Each row
 * is a root session (`parent_id IS NULL`) with its subagent count computed via a
 * correlated subquery over its children.
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
    if (typeof dbOrPath === "string") {
      db = new Database(dbOrPath, { readonly: true })
      ownConnection = true
    } else {
      db = dbOrPath
    }

    const orderBy = sort === "cost" ? "s.cost" : "(s.tokens_input + s.tokens_output)"

    const rows = db
      .query(
        `SELECT
           s.id,
           s.title,
           s.cost,
           s.tokens_input  AS tokensInput,
           s.tokens_output AS tokensOutput,
           (s.tokens_input + s.tokens_output) AS tokens,
           (SELECT COUNT(*) FROM session c WHERE c.parent_id = s.id) AS subagentCount,
           s.time_created AS timeCreated
         FROM session s
         WHERE s.parent_id IS NULL
           AND s.time_created >= ?
           AND s.time_created < ?
         ORDER BY ${orderBy} DESC
         LIMIT 10`,
      )
      .all(startMs, endMs) as TopSession[]

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
    if (ownConnection) {
      try { db?.close() } catch { /* ignore */ }
    }
  }
}

export function fetchRootSessionTimestamps(dbOrPath: Database | string, startMs: number, endMs: number): number[] | { error: string } {
  let db: Database | null = null
  let ownConnection = false
  try {
    if (typeof dbOrPath === "string") {
      db = new Database(dbOrPath, { readonly: true })
      ownConnection = true
    } else {
      db = dbOrPath
    }

    const rows = db
      .query(
        `SELECT time_created FROM session WHERE parent_id IS NULL AND time_created >= ? AND time_created < ?`
      )
      .all(startMs, endMs) as { time_created: number }[]

    return (rows ?? []).map(r => r.time_created)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (ownConnection) {
      try { db?.close() } catch { /* ignore */ }
    }
  }
}

export function queryUsage(dbOrPath: Database | string, startMs: number, endMs: number): UsageData | { error: string } {
  let db: Database | null = null
  let ownConnection = false
  try {
    if (typeof dbOrPath === "string") {
      db = new Database(dbOrPath, { readonly: true })
      ownConnection = true
    } else {
      db = dbOrPath
    }

    const rows = db
      .query(
        `SELECT
           json_extract(data, '$.modelID')                     AS model_id,
           json_extract(data, '$.providerID')                  AS provider_id,
           SUM(CAST(json_extract(data, '$.cost') AS REAL))     AS total_cost,
           SUM(CAST(json_extract(data, '$.tokens.input')  AS INTEGER)) AS total_input,
           SUM(CAST(json_extract(data, '$.tokens.output') AS INTEGER)) AS total_output
         FROM message
         WHERE json_extract(data, '$.role') = 'assistant'
           AND time_created >= ?
           AND time_created <  ?
         GROUP BY provider_id, model_id
         ORDER BY (total_input + total_output) DESC
         LIMIT ${MAX_MODELS}`,
      )
      .all(startMs, endMs) as UsageRow[]

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
    if (ownConnection) {
      try {
        db?.close()
      } catch {
        /* already closed */
      }
    }
  }
}

export function fetchRawRows(dbOrPath: Database | string, startMs: number, endMs: number): RawUsageRow[] | { error: string } {
  let db: Database | null = null
  let ownConnection = false
  try {
    if (typeof dbOrPath === "string") {
      db = new Database(dbOrPath, { readonly: true })
      ownConnection = true
    } else {
      db = dbOrPath
    }

    const rows = db
      .query(
        `SELECT 
           time_created,
           json_extract(data, '$.modelID') AS model_id,
           json_extract(data, '$.providerID') AS provider_id,
           CAST(json_extract(data, '$.cost') AS REAL) AS cost,
           CAST(json_extract(data, '$.tokens.input') AS INTEGER) AS input_tokens,
           CAST(json_extract(data, '$.tokens.output') AS INTEGER) AS output_tokens
         FROM message
         WHERE json_extract(data, '$.role') = 'assistant'
           AND time_created >= ?
           AND time_created < ?
         ORDER BY time_created ASC`,
      )
      .all(startMs, endMs) as RawUsageRow[]

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
    if (ownConnection) {
      try { db?.close() } catch { /* ignore */ }
    }
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
 * SQL `GROUP BY` over the day expression.
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
    if (typeof dbOrPath === "string") {
      db = new Database(dbOrPath, { readonly: true })
      ownConnection = true
    } else {
      db = dbOrPath
    }

    const rows = db
      .query(
        `SELECT
           (time_created / 86400000) * 86400000 AS day_start,
           SUM(CAST(json_extract(data,'$.tokens.input')  AS INTEGER)) AS input_tokens,
           SUM(CAST(json_extract(data,'$.tokens.output') AS INTEGER)) AS output_tokens,
           SUM(CAST(json_extract(data,'$.cost') AS REAL)) AS cost
         FROM message
         WHERE json_extract(data,'$.role') = 'assistant'
           AND time_created >= ? AND time_created < ?
         GROUP BY day_start
         ORDER BY day_start ASC`,
      )
      .all(startMs, endMs) as DailyTotal[]

    return (rows ?? []).map((r: DailyTotal) => ({
      day_start: r.day_start,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
      cost: r.cost ?? 0,
    }))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (ownConnection) {
      try { db?.close() } catch { /* ignore */ }
    }
  }
}

export function getEarliestUsageDate(dbOrPath: Database | string): number | null {
  let db: Database | null = null
  let ownConnection = false
  try {
    if (typeof dbOrPath === "string") {
      db = new Database(dbOrPath, { readonly: true })
      ownConnection = true
    } else {
      db = dbOrPath
    }
    const row = db
      .query(
        `SELECT MIN(time_created) AS earliest
         FROM message
         WHERE json_extract(data, '$.role') = 'assistant'`
      )
      .get() as { earliest: number | null } | undefined
    return row?.earliest ?? null
  } catch {
    return null
  } finally {
    if (ownConnection) {
      try { db?.close() } catch { /* ignore */ }
    }
  }
}

/**
 * Creates a time_created index on the `message` table if it does not exist.
 * Opens a READ-WRITE connection (the plugin otherwise reads the DB read-only),
 * wrapped so any failure (e.g. "database is locked") is non-fatal.
 * Idempotent: a no-op when the index already exists.
 */
export function ensureMessageTimeIndex(dbPath: string): boolean {
  let db: Database | null = null
  try {
    db = new Database(dbPath)
    db.exec("PRAGMA busy_timeout = 3000")
    db.exec("CREATE INDEX IF NOT EXISTS message_time_created_idx ON message(time_created)")
    return true
  } catch {
    return false
  } finally {
    try { db?.close() } catch { /* ignore */ }
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
    if (typeof dbOrPath === "string") {
      db = new Database(dbOrPath, { readonly: true })
      ownConnection = true
    } else {
      db = dbOrPath
    }
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
    if (ownConnection) {
      try { db?.close() } catch { /* ignore */ }
    }
  }
}
