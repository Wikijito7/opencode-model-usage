import { describe, it, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SQLITE_DB_PATH,
  SQLITE_FALLBACK_NOTE,
  selectUsageBackend,
  isSqliteAvailable,
  type UsageBackend,
} from "@model-usage/v2/backend"

// ─── selectUsageBackend ───────────────────────────────────────────────────────

describe("selectUsageBackend", () => {
  it("prefers the v2 data API when historical queries are supported", () => {
    expect(selectUsageBackend({ hasV2History: true, hasSqlite: false })).toBe<UsageBackend>("v2-data")
    expect(selectUsageBackend({ hasV2History: true, hasSqlite: true })).toBe<UsageBackend>("v2-data")
  })

  it("falls back to sqlite when v2 history is unavailable but a database exists", () => {
    expect(selectUsageBackend({ hasV2History: false, hasSqlite: true })).toBe<UsageBackend>("sqlite")
  })

  it("returns none when neither source is usable", () => {
    expect(selectUsageBackend({ hasV2History: false, hasSqlite: false })).toBe<UsageBackend>("none")
  })

  it("never returns sqlite while v2 history is available (v2 wins)", () => {
    const result = selectUsageBackend({ hasV2History: true, hasSqlite: true })
    expect(result).not.toBe("sqlite")
  })
})

// ─── isSqliteAvailable ────────────────────────────────────────────────────────

describe("isSqliteAvailable", () => {
  it("returns true for an existing database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    const dbPath = join(dir, "opencode.db")
    try {
      writeFileSync(dbPath, "")
      expect(isSqliteAvailable(dbPath)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns false for a path that does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      expect(isSqliteAvailable(join(dir, "missing.db"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns true for an existing directory path (existsSync semantics)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      expect(isSqliteAvailable(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns false rather than throwing for an invalid path", () => {
    expect(isSqliteAvailable("\u0000not-a-path")).toBe(false)
  })
})

// ─── constants ────────────────────────────────────────────────────────────────

describe("backend constants", () => {
  it("exposes the default OpenCode database path", () => {
    expect(SQLITE_DB_PATH).toContain(".local/share/opencode")
    expect(SQLITE_DB_PATH.endsWith("opencode.db")).toBe(true)
  })

  it("describes the retained sqlite fallback in prose", () => {
    expect(typeof SQLITE_FALLBACK_NOTE).toBe("string")
    expect(SQLITE_FALLBACK_NOTE.length).toBeGreaterThan(0)
    expect(SQLITE_FALLBACK_NOTE).toContain("SQLite")
  })
})
