/**
 * model-usage — v2 data backend strategy.
 *
 * OpenCode 2.0.27 exposes session/message/cost data through the TUI plugin
 * `Context.data` API (`@opencode/client`) and the server `Context` client.
 * That API is the **preferred** source for data scoped to the *current*
 * session (analyze breakdown, sidebar cost/quota token tallies).
 *
 * It does **not** expose an historical, arbitrary-period, per-model
 * aggregation (e.g. "all models in July, grouped by provider/model, with
 * cost"). The `/usage` dialog needs exactly that, so the plugin retains a
 * read-only SQLite fallback against OpenCode's own database. This module owns
 * that boundary — both availability (`isSqliteAvailable`) and opening
 * (`openUsageDatabase`) — so the UI never imports or opens `bun:sqlite`
 * itself and the domain layer never imports the host API.
 *
 * The only runtime dependency here is `bun:sqlite`; the module must not import
 * `@opencode/plugin` or SolidJS.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"

/** Default OpenCode SQLite database path (historical usage fallback). */
export const SQLITE_DB_PATH = `${homedir()}/.local/share/opencode/opencode.db`

/** SQLite file magic: every valid database starts with these 16 bytes. */
const SQLITE_MAGIC = "SQLite format 3\u0000"

/**
 * Which backend `/usage` should read historical usage from.
 * - `v2-data` — only when a supported v2 API can answer the query (not yet
 *   available for arbitrary periods; reserved for future host versions).
 * - `sqlite` — the retained read-only fallback.
 * - `none` — no usable source; the UI must render a clear empty state.
 */
export type UsageBackend = "v2-data" | "sqlite" | "none"

export interface UsageBackendInput {
  /** A supported v2 data/client API can answer the historical query. */
  readonly hasV2History: boolean
  /** A readable OpenCode SQLite database exists. */
  readonly hasSqlite: boolean
}

/**
 * Select the historical-usage backend. v2 history wins when the host supports
 * it; otherwise fall back to SQLite; otherwise report `none` so the UI can
 * degrade explicitly instead of throwing.
 */
export function selectUsageBackend(input: UsageBackendInput): UsageBackend {
  if (input.hasV2History) return "v2-data"
  if (input.hasSqlite) return "sqlite"
  return "none"
}

/**
 * Why the retained SQLite fallback is (or is not) usable. Distinguishing these
 * lets the UI render an accurate empty state instead of blaming every failure
 * on a "missing" database.
 * - `available`  — a readable regular file whose first 16 bytes are the magic.
 * - `missing`    — nothing exists at the path (`ENOENT`).
 * - `malformed`  — the path exists but is not a SQLite database (a directory,
 *                  an empty/truncated file, or a file with the wrong header).
 * - `unreadable` — the file looks like a database but cannot be read
 *                  (permissions, I/O error, or a race with a concurrent writer).
 */
export type SqliteDbStatus = "available" | "missing" | "malformed" | "unreadable"

/**
 * Classify the OpenCode SQLite database at `dbPath`.
 *
 * Never throws: filesystem/read failures are folded into `missing`,
 * `malformed`, or `unreadable`. This is the single source of truth for both
 * `isSqliteAvailable` and `openUsageDatabase`, so the availability check and
 * the open path can never disagree about what counts as a database.
 */
export function sqliteDbStatus(dbPath: string = SQLITE_DB_PATH): SqliteDbStatus {
  try {
    const stat = statSync(dbPath)
    if (!stat.isFile() || stat.size < SQLITE_MAGIC.length) return "malformed"
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable"
  }

  let fd: number
  try {
    fd = openSync(dbPath, "r")
  } catch {
    return "unreadable"
  }
  try {
    const header = Buffer.alloc(SQLITE_MAGIC.length)
    const read = readSync(fd, header, 0, SQLITE_MAGIC.length, 0)
    if (read !== SQLITE_MAGIC.length) return "malformed"
    return header.toString("latin1") === SQLITE_MAGIC ? "available" : "malformed"
  } catch {
    return "unreadable"
  } finally {
    closeSync(fd)
  }
}

/**
 * Whether the retained SQLite fallback is available.
 *
 * Requires a readable **regular file** whose first 16 bytes are the SQLite
 * header (`"SQLite format 3\0"`). A directory, a missing path, an unreadable
 * file, or an arbitrary/empty file all report `false`, so the caller degrades
 * to the explicit empty state instead of opening a non-database.
 */
export function isSqliteAvailable(dbPath: string = SQLITE_DB_PATH): boolean {
  return sqliteDbStatus(dbPath) === "available"
}

/** Result of opening the historical SQLite fallback. */
export interface UsageDatabaseHandle {
  /** The opened read-only database, or `null` when opening failed. */
  readonly db: Database | null
  /** Human-readable failure reason when `db` is `null`. */
  readonly error?: string
}

/**
 * Open OpenCode's SQLite database read-only for the historical fallback.
 *
 * The SQLite header is validated here, inside the open path itself, rather than
 * trusting the caller's prior `isSqliteAvailable` check: the file can be
 * deleted, replaced, or corrupted between the check and the open. A file that
 * is not a valid database is rejected up front, and a header that passes the
 * check but has since changed is caught by forcing SQLite to validate the
 * on-disk schema immediately (otherwise the failure surfaces lazily on the
 * first real query, far from this boundary).
 *
 * Never throws: a failure is returned as `{ db: null, error }` so the UI can
 * render an explicit message. Keeping this here means the TUI never imports
 * `bun:sqlite` or constructs a `Database` directly.
 */
export function openUsageDatabase(dbPath: string = SQLITE_DB_PATH): UsageDatabaseHandle {
  const status = sqliteDbStatus(dbPath)
  if (status !== "available") {
    return { db: null, error: `Not a usable SQLite database (${status}): ${dbPath}` }
  }

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    // Force SQLite to validate the on-disk header/schema now (guards the
    // validation/open race); a swapped or corrupt file fails here.
    db.query("PRAGMA schema_version").get()
    return { db }
  } catch (err) {
    try { db?.close() } catch { /* ignore */ }
    return { db: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Human-readable description of the fallback for docs/UI, so an unsupported
 * area is stated rather than silently breaking.
 */
export const SQLITE_FALLBACK_NOTE =
  "Historical per-model usage across arbitrary periods is read from OpenCode's " +
  "read-only SQLite database; the v2 data API does not expose this aggregation."
