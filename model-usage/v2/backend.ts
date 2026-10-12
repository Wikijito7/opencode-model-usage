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
 * read-only SQLite fallback against OpenCode's own database. The fallback is
 * isolated here so the domain layer never imports the host API or
 * `bun:sqlite` directly.
 *
 * This module is pure (except `isSqliteAvailable`, which only stats a path)
 * and must not import `@opencode/plugin`, SolidJS, or `bun:sqlite`.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"

/** Default OpenCode SQLite database path (historical usage fallback). */
export const SQLITE_DB_PATH = `${homedir()}/.local/share/opencode/opencode.db`

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

/** Whether the retained SQLite fallback is available. */
export function isSqliteAvailable(dbPath: string = SQLITE_DB_PATH): boolean {
  try {
    return existsSync(dbPath)
  } catch {
    return false
  }
}

/**
 * Human-readable description of the fallback for docs/UI, so an unsupported
 * area is stated rather than silently breaking.
 */
export const SQLITE_FALLBACK_NOTE =
  "Historical per-model usage across arbitrary periods is read from OpenCode's " +
  "read-only SQLite database; the v2 data API does not expose this aggregation."
