/**
 * model-usage — OpenCode v2 server **setup helper** (non-entrypoint).
 *
 * Target: OpenCode `2.0.27` (`@opencode/plugin` Promise API). This module is
 * NOT a plugin entrypoint: it exports a plain `setup(context)` function and has
 * **no default export**, so OpenCode v2's directory resolution does not load it
 * as a second server plugin. The actual combined entrypoint is the root
 * `../model-usage-server.ts`, whose default object carries `{ id, server, setup }`.
 * The `setup` export here is threaded into that object by the root file.
 *
 * This module deliberately does not import `Plugin.define` (or any other
 * runtime `@opencode/plugin` value): the root v1 entrypoint imports it, so it
 * must stay loadable by OpenCode v1. The `@opencode/plugin` reference below is
 * a **type-only** import (erased at runtime).
 *
 * ## Hook: `session.hook("context")`
 *
 * In v1 the server observed `experimental.chat.system.transform` for the
 * system prompt and a separate `tool.definition` hook for tool schemas. In v2
 * both arrive together, immediately before provider dispatch, on the session
 * `context` hook (`SessionContext`):
 *
 * - `event.system: Array<SystemPart>` — the assembled system parts
 *   (`{ type: "text", text }`), captured pre-mutation exactly like v1.
 * - `event.tools: Record<name, { description, input }>` — the effective tool
 *   definitions for this request.
 *
 * `session.hook("context")` fires for the **primary** agent loop only; title
 * generation uses the separate `session.hook("title")`, so title-generator
 * calls are structurally excluded. `isTitleGenerator()` is kept as a defensive
 * guard (the tiny title system must never pollute the stored snapshot).
 *
 * ## Preserved v1 behaviour
 *
 * - Title-generator skip (defensive).
 * - Drift throttling: only flush to disk when the token count moved by more
 *   than `DRIFT_THRESHOLD` (32); refresh the timestamp at most every 5 min.
 * - Compaction detection: a measurement < 70% of the previous one is treated as
 *   a post-compaction replacement and overwrites the smaller value.
 * - FIFO purge (1000-entry cap / 100 eviction) and rawText/fragment backfill.
 * - Persistence paths are unchanged (`system-tokens.json`, `tool-defs.json`) so
 *   the persona-injector system-snapshot contract and the `/analyze` reader
 *   keep working: the sidecar (`readSystemSnapshot`) still wins at analyze time
 *   for the final post-injection system.
 * - Tool-definition snapshots retain their `ToolDefSnapshot` shape and are
 *   rebuilt from the complete effective tool set on every qualifying call. When
 *   that set is empty, any snapshot stored for the session is removed (v2
 *   delivers the whole set per request, so the previous request's tools would
 *   otherwise linger as stale data); the file shape/path/FIFO purge are
 *   unchanged from v1.
 *
 * No TUI/JSX imports — this module is server-only.
 */

import type { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { estimateTokens } from "./helpers/tokens"
import { log } from "./helpers/debug"
import { splitSystemFragments } from "./helpers/fragments"
import type { SystemSnapshot, ToolDefSnapshot } from "./types"

export const PLUGIN_ID = "model-usage"

const TOKENS_DIR = `${homedir()}/.config/opencode/plugins/model-usage`
const TOKENS_FILE = `${TOKENS_DIR}/system-tokens.json`
const TOOL_DEFS_FILE = `${TOKENS_DIR}/tool-defs.json`
const MAX_ENTRIES = 1000
const PURGE_COUNT = 100
// Only flush to disk if the token count drifted by this many tokens since the
// last persisted value — avoids re-writing the file when nothing material
// changed (e.g. identical system on a cached re-fire).
const DRIFT_THRESHOLD = 32
// Refresh a timestamp at most this often when nothing material changed.
const TIMESTAMP_REFRESH_MS = 5 * 60 * 1000

// Serialized writes to prevent race conditions from concurrent API calls.
let writeQueue: Promise<void> = Promise.resolve()

// In-memory cache of tool-def snapshots (disk is source of truth), so a chatty
// session does not re-read the file on every context call.
let toolDefsCache: Record<string, ToolDefSnapshot> | null = null

function ensureDir() {
  try { mkdirSync(TOKENS_DIR, { recursive: true }) } catch { /* ignore */ }
}

function loadTokens(): Record<string, SystemSnapshot> {
  ensureDir()
  try {
    if (existsSync(TOKENS_FILE)) {
      return JSON.parse(readFileSync(TOKENS_FILE, "utf-8"))
    }
  } catch { /* ignore */ }
  return {}
}

function saveTokens(data: Record<string, SystemSnapshot>): Promise<void> {
  const entries = Object.entries(data)
  if (entries.length > MAX_ENTRIES) {
    const sorted = entries.sort((a, b) => a[1].ts - b[1].ts)
    data = Object.fromEntries(sorted.slice(PURGE_COUNT))
  }
  writeQueue = writeQueue.then(() => {
    ensureDir()
    try {
      writeFileSync(TOKENS_FILE, JSON.stringify(data))
    } catch { /* ignore */ }
  })
  return writeQueue
}

function loadToolDefs(): Record<string, ToolDefSnapshot> {
  ensureDir()
  try {
    if (existsSync(TOOL_DEFS_FILE)) {
      const data = JSON.parse(readFileSync(TOOL_DEFS_FILE, "utf-8"))
      log("loadToolDefs: loaded", Object.keys(data).length, "sessions from tool-defs.json")
      return data
    }
  } catch { /* ignore */ }
  return {}
}

function saveToolDefs(data: Record<string, ToolDefSnapshot>): Promise<void> {
  const entries = Object.entries(data)
  if (entries.length > MAX_ENTRIES) {
    const sorted = entries.sort((a, b) => a[1].ts - b[1].ts)
    data = Object.fromEntries(sorted.slice(PURGE_COUNT))
  }
  writeQueue = writeQueue.then(() => {
    ensureDir()
    try {
      writeFileSync(TOOL_DEFS_FILE, JSON.stringify(data))
    } catch { /* ignore */ }
  })
  return writeQueue
}

/**
 * Title-generation calls carry a tiny "You are a title generator" system.
 * Under v2 they use a separate `title` hook, but keep this defensive guard so
 * the stored session snapshot can never be clobbered by one.
 */
export function isTitleGenerator(system: string): boolean {
  return system.toLowerCase().includes("title generator")
}

interface SystemPartLike {
  readonly text?: string
}

interface ToolDefLike {
  readonly description?: string
  readonly input?: unknown
}

/** Reconstruct the tool-definition text exactly as sent to the provider. */
export function buildToolDefText(name: string, def: ToolDefLike): string {
  const paramsText = def.input ? JSON.stringify(def.input) : ""
  return `Tool: ${name}\nDescription: ${def.description ?? ""}\nParameters: ${paramsText}`
}

/** Build a `ToolDefSnapshot` from the effective tool set of one request. */
export function buildToolDefSnapshot(tools: Record<string, ToolDefLike> | undefined): ToolDefSnapshot | null {
  const entries = Object.entries(tools ?? {})
  if (entries.length === 0) return null
  const fragments: ToolDefSnapshot["fragments"] = []
  const texts: string[] = []
  for (const [name, def] of entries) {
    const text = buildToolDefText(name, def)
    fragments.push({ label: name, tokens: estimateTokens(text) })
    texts.push(text)
  }
  return {
    t: fragments.reduce((sum, f) => sum + f.tokens, 0),
    ts: Date.now(),
    fragments,
    rawText: texts.join("\n\n"),
  }
}

/**
 * Fold one request's **complete** effective tool set into the persisted store,
 * applying v2 "replace, don't accumulate" semantics. Returns whether the store
 * changed.
 *
 * - A non-empty set replaces the session's snapshot; a write is only reported
 *   when the reconstructed `rawText` or summed total actually changed.
 * - An empty set (`{}` or `undefined`) means this request sent no tools, so any
 *   snapshot previously stored for the session is stale and is removed. This
 *   keeps `/analyze` from reporting tool definitions the model did not receive.
 *
 * Persistence semantics stay v1-compatible: the same `ToolDefSnapshot` shape,
 * file path and FIFO purge are used; only the "no tools" case clears the entry
 * instead of leaving the previous request's definitions behind.
 */
export function applyToolDefSnapshot(
  store: Record<string, ToolDefSnapshot>,
  sessionID: string,
  tools: Record<string, ToolDefLike> | undefined,
): boolean {
  const snapshot = buildToolDefSnapshot(tools)
  const prev = store[sessionID]

  if (snapshot) {
    if (!prev || prev.rawText !== snapshot.rawText || prev.t !== snapshot.t) {
      store[sessionID] = snapshot
      return true
    }
    return false
  }

  // Complete effective set is empty → drop a stale snapshot if one exists.
  if (prev) {
    delete store[sessionID]
    return true
  }
  return false
}

/**
 * Fold a fresh system measurement into the persisted store, applying the
 * drift/compaction/backfill policy. Returns whether the store changed.
 */
export function mergeSystemSnapshot(
  store: Record<string, SystemSnapshot>,
  sessionID: string,
  allText: string,
  now: number,
): boolean {
  const tokens = estimateTokens(allText)
  const fragments = splitSystemFragments(allText)
  const prev = store[sessionID]

  if (prev) {
    // Compaction / major change: dramatically smaller system → replace.
    if (tokens < prev.t * 0.7) {
      store[sessionID] = { t: tokens, ts: now, fragments, rawText: allText }
      return true
    }
    // No material change → refresh timestamp occasionally, or backfill
    // rawText/fragments for legacy entries captured before they were stored.
    if (Math.abs(tokens - prev.t) <= DRIFT_THRESHOLD) {
      if (!prev.fragments || prev.fragments.length === 0) {
        prev.rawText = allText
        prev.fragments = fragments
        prev.ts = now
        return true
      }
      if (now - prev.ts >= TIMESTAMP_REFRESH_MS) {
        prev.ts = now
        return true
      }
      return false
    }
  }

  store[sessionID] = { t: tokens, ts: now, fragments, rawText: allText }
  return true
}

/**
 * OpenCode v2 server setup. Exported as a plain function so the combined root
 * entrypoint (`../model-usage-server.ts`) can expose it as the default object's
 * `setup` property without this module depending on `Plugin.define`.
 *
 * The v1 (`server`) and v2 (`setup`) implementations never share a host API:
 * this function only ever touches the v2 `context.session` surface.
 */
export async function setup(ctx: Plugin.Context): Promise<void> {
  // Load the persisted system snapshots once; the map is the write-through
  // cache and disk remains the source of truth.
  const cache: Record<string, SystemSnapshot> = loadTokens()

  await ctx.session.hook("context", async (event) => {
    const sessionID = event.sessionID
    log("model-usage-server(v2): session.hook context for", sessionID,
      "system parts:", (event.system ?? []).length,
      "tools:", Object.keys(event.tools ?? {}).length)
    if (!sessionID) return

    const parts = (event.system ?? []) as readonly SystemPartLike[]
    const allText = parts.map((p) => p.text ?? "").join("\n")
    if (isTitleGenerator(allText)) return
    if (allText.trim().length === 0) return

    const now = Date.now()
    const changed = mergeSystemSnapshot(cache, sessionID, allText, now)
    if (changed) await saveTokens(cache)

    // Tool definitions: v2 delivers the complete effective set for this
    // request, so replace (not accumulate) the session's snapshot. An empty
    // set clears any stale snapshot rather than leaving the previous
    // request's definitions behind. Only persist on an actual change.
    if (toolDefsCache === null) toolDefsCache = loadToolDefs()
    const defsChanged = applyToolDefSnapshot(toolDefsCache, sessionID, event.tools)
    if (defsChanged) {
      await saveToolDefs(toolDefsCache)
      log("model-usage-server(v2): tool defs updated for", sessionID,
        "tools:", Object.keys(event.tools ?? {}).length,
        "stored sessions:", Object.keys(toolDefsCache).length)
    }
  })
}
