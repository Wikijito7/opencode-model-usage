import { describe, it, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import {
  SQLITE_DB_PATH,
  SQLITE_FALLBACK_NOTE,
  selectUsageBackend,
  isSqliteAvailable,
  sqliteDbStatus,
  openUsageDatabase,
  type UsageBackend,
} from "@model-usage/v2/backend"

/** The 16-byte SQLite file header, mirrored from the backend's own magic. */
const SQLITE_MAGIC = "SQLite format 3\u0000"

/** Write a file whose first 16 bytes are the SQLite magic plus `garbage`. */
function writeMagicFileWithGarbage(dir: string, name: string, totalBytes = 200): string {
  const dbPath = join(dir, name)
  const buf = Buffer.alloc(totalBytes)
  buf.write(SQLITE_MAGIC, 0, "latin1")
  // Deliberately not a valid database beyond the header: page-size/format fields
  // are garbage, so SQLite rejects it once it actually reads the header.
  for (let i = SQLITE_MAGIC.length; i < totalBytes; i++) buf[i] = (i * 31) % 256
  writeFileSync(dbPath, buf)
  return dbPath
}

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

/** Create a genuine, on-disk SQLite database with bun:sqlite and close it. */
function writeRealSqlite(dir: string, name = "opencode.db"): string {
  const dbPath = join(dir, name)
  const db = new Database(dbPath)
  try {
    db.exec("CREATE TABLE usage (id INTEGER PRIMARY KEY, model TEXT)")
  } finally {
    db.close()
  }
  return dbPath
}

describe("isSqliteAvailable", () => {
  it("returns true for a real SQLite database file created by bun:sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const dbPath = writeRealSqlite(dir)
      expect(isSqliteAvailable(dbPath)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns false for an empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const dbPath = join(dir, "opencode.db")
      writeFileSync(dbPath, "")
      expect(isSqliteAvailable(dbPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns false for a file with arbitrary content (wrong SQLite magic)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const dbPath = join(dir, "not-a-db.db")
      writeFileSync(dbPath, "this is definitely not a sqlite database file")
      expect(isSqliteAvailable(dbPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns false for a file too short to hold the SQLite header", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const dbPath = join(dir, "tiny.db")
      writeFileSync(dbPath, "SQLite format 3") // 15 bytes, magic needs 16
      expect(isSqliteAvailable(dbPath)).toBe(false)
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

  it("returns false for a directory path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const sub = join(dir, "a-directory")
      mkdirSync(sub)
      expect(isSqliteAvailable(sub)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns false rather than throwing for an invalid path", () => {
    expect(isSqliteAvailable("\u0000not-a-path")).toBe(false)
  })
})

// ─── sqliteDbStatus ───────────────────────────────────────────────────────────

describe("sqliteDbStatus", () => {
  it("classifies a genuine SQLite database as available", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      expect(sqliteDbStatus(writeRealSqlite(dir))).toBe("available")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("classifies a non-existent path as missing (ENOENT)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      expect(sqliteDbStatus(join(dir, "does-not-exist.db"))).toBe("missing")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("classifies a directory as malformed, not missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const sub = join(dir, "a-directory")
      mkdirSync(sub)
      expect(sqliteDbStatus(sub)).toBe("malformed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("classifies an empty file as malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const dbPath = join(dir, "empty.db")
      writeFileSync(dbPath, "")
      expect(sqliteDbStatus(dbPath)).toBe("malformed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("classifies a file with the wrong header as malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const dbPath = join(dir, "wrong.db")
      writeFileSync(dbPath, "this is definitely not a sqlite database file")
      expect(sqliteDbStatus(dbPath)).toBe("malformed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("classifies an unreadable file as unreadable, not malformed", () => {
    // Running as root would bypass the permission bits, so the read would
    // succeed and this branch could not be exercised. Skip in that case.
    if (typeof process.getuid === "function" && process.getuid() === 0) return

    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const dbPath = join(dir, "no-permission.db")
      const buf = Buffer.alloc(100)
      buf.write(SQLITE_MAGIC, 0, "latin1")
      writeFileSync(dbPath, buf)
      chmodSync(dbPath, 0o000)
      try {
        // Header is valid and the size is ample; only the open/read fails.
        expect(sqliteDbStatus(dbPath)).toBe("unreadable")
      } finally {
        chmodSync(dbPath, 0o644)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("classifies an invalid path (non-ENOENT filesystem error) as unreadable", () => {
    // A NUL byte in the path is not ENOENT; the backend folds any other
    // filesystem error into unreadable rather than throwing.
    expect(sqliteDbStatus("\u0000not-a-path")).toBe("unreadable")
  })
})

// ─── openUsageDatabase ────────────────────────────────────────────────────────

describe("openUsageDatabase", () => {
  it("opens a real SQLite database read-only and returns a usable handle", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const dbPath = writeRealSqlite(dir)
      const handle = openUsageDatabase(dbPath)
      expect(handle.error).toBeUndefined()
      expect(handle.db).not.toBeNull()
      try {
        expect(handle.db!.query("SELECT 1 AS n").get()).toEqual({ n: 1 })
      } finally {
        handle.db!.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns a read-only handle that rejects writes and DDL while reads succeed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    const handle = openUsageDatabase(writeRealSqlite(dir))
    try {
      expect(handle.error).toBeUndefined()
      expect(handle.db).not.toBeNull()
      const db = handle.db!

      // Reads must work through the handle...
      expect(db.query("SELECT 1 AS n").get()).toEqual({ n: 1 })

      // ...but every mutating statement must be refused by SQLite. Assert on
      // the message so a future change to `{ readonly: true }` (which would
      // silently open a writable handle) fails this regression test loudly.
      const readonlyMessage = /attempt to write a readonly database/i
      expect(() => db.run("INSERT INTO usage (model) VALUES ('x')")).toThrow(readonlyMessage)
      expect(() => db.exec("CREATE TABLE should_not_exist (id INTEGER)")).toThrow(readonlyMessage)
      expect(() => db.exec("DROP TABLE usage")).toThrow(readonlyMessage)

      // The rejected DDL must not have taken effect: the table is still there
      // and the injected table was never created.
      expect(
        db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      ).toEqual([{ name: "usage" }])
    } finally {
      // Cleanup must close the handle even when an assertion above throws.
      handle.db?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns a graceful failure for a directory path instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const handle = openUsageDatabase(dir)
      expect(handle.db).toBeNull()
      expect(typeof handle.error).toBe("string")
      expect(handle.error!.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns a graceful failure for a missing path instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const handle = openUsageDatabase(join(dir, "missing.db"))
      expect(handle.db).toBeNull()
      expect(typeof handle.error).toBe("string")
      expect(handle.error!.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a header-valid-but-corrupt database without trusting caller validation", () => {
    // sqliteDbStatus sees the magic and reports `available`; the corruption is
    // only caught because openUsageDatabase forces SQLite to validate the
    // on-disk schema immediately. This is the validation/open race the backend
    // guards against, so it must fail here even though a prior
    // isSqliteAvailable() check would have passed.
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const dbPath = writeMagicFileWithGarbage(dir, "corrupt.db")
      expect(sqliteDbStatus(dbPath)).toBe("available")
      expect(isSqliteAvailable(dbPath)).toBe(true)

      const handle = openUsageDatabase(dbPath)
      expect(handle.db).toBeNull()
      expect(typeof handle.error).toBe("string")
      expect(handle.error!.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a non-database regular file passed directly (no prior availability check)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-backend-"))
    try {
      const dbPath = join(dir, "notes.txt")
      writeFileSync(dbPath, "plain text, not a database at all")
      const handle = openUsageDatabase(dbPath)
      expect(handle.db).toBeNull()
      expect(handle.error).toContain("malformed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
