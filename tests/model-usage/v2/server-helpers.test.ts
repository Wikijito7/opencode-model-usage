import { describe, it, expect, mock, beforeAll } from "bun:test"
import { estimateTokens } from "@model-usage/helpers/tokens"
import { splitSystemFragments } from "@model-usage/helpers/fragments"
import type { SystemSnapshot, ToolDefSnapshot } from "@model-usage/types"

// The v2 helper lives at `model-usage/server-setup.ts` (non-entrypoint; the
// combined entry is the flat root `model-usage-server.ts`). Its only host
// reference is a **type-only** `@opencode/plugin` import, which is erased at
// runtime, so these pure helpers load without a running host. The host module
// stub is kept as a defensive no-op (test-only, production untouched) in case a
// future refactor reintroduces a runtime host import, and the helper is loaded
// dynamically so its non-entrypoint exports can be exercised.
type ServerModule = typeof import("@model-usage/server-setup")
let server: ServerModule

beforeAll(async () => {
  mock.module("@opencode/plugin", () => ({ Plugin: { define: (config: unknown) => config } }))
  server = await import("@model-usage/server-setup")
})

// ─── isTitleGenerator ─────────────────────────────────────────────────────────

describe("isTitleGenerator", () => {
  it("detects the title-generator system case-insensitively", () => {
    expect(server.isTitleGenerator("You are a title generator.")).toBe(true)
    expect(server.isTitleGenerator("you are a TITLE GENERATOR for the session")).toBe(true)
    expect(server.isTitleGenerator("TITLE GENERATOR")).toBe(true)
  })

  it("detects the marker anywhere inside a larger assembled system", () => {
    expect(server.isTitleGenerator("prefix\ntitle generator\nsuffix")).toBe(true)
  })

  it("returns false for a normal system prompt", () => {
    expect(server.isTitleGenerator("You are OpenCode, an interactive CLI tool.")).toBe(false)
  })

  it("returns false for empty input", () => {
    expect(server.isTitleGenerator("")).toBe(false)
  })

  it("does not match a partial word (no 'generator')", () => {
    expect(server.isTitleGenerator("title generation service")).toBe(false)
  })
})

// ─── buildToolDefText ─────────────────────────────────────────────────────────

describe("buildToolDefText", () => {
  it("reconstructs the exact text sent to the provider", () => {
    const text = server.buildToolDefText("bash", { description: "Run a command", input: { type: "object" } })
    expect(text).toBe('Tool: bash\nDescription: Run a command\nParameters: {"type":"object"}')
  })

  it("emits an empty Parameters section when the definition has no input", () => {
    const text = server.buildToolDefText("noop", { description: "does nothing" })
    expect(text).toBe("Tool: noop\nDescription: does nothing\nParameters: ")
  })

  it("emits an empty Description when the definition has none", () => {
    const text = server.buildToolDefText("noop", { input: { a: 1 } })
    expect(text).toBe('Tool: noop\nDescription: \nParameters: {"a":1}')
  })
})

// ─── buildToolDefSnapshot ─────────────────────────────────────────────────────

describe("buildToolDefSnapshot", () => {
  it("returns null for undefined or empty tool sets", () => {
    expect(server.buildToolDefSnapshot(undefined)).toBeNull()
    expect(server.buildToolDefSnapshot({})).toBeNull()
  })

  it("builds fragments, a summed token total and rawText from the effective tools", () => {
    const tools = {
      bash: { description: "Run a command", input: { type: "object" } },
      read: { description: "Read a file", input: { type: "string" } },
    }
    const snapshot = server.buildToolDefSnapshot(tools)
    expect(snapshot).not.toBeNull()
    const snap = snapshot as NonNullable<typeof snapshot>

    const bashText = server.buildToolDefText("bash", tools.bash)
    const readText = server.buildToolDefText("read", tools.read)

    expect(snap.fragments).toEqual([
      { label: "bash", tokens: estimateTokens(bashText) },
      { label: "read", tokens: estimateTokens(readText) },
    ])
    expect(snap.t).toBe(snap.fragments.reduce((sum, f) => sum + f.tokens, 0))
    expect(snap.rawText).toBe(`${bashText}\n\n${readText}`)
    expect(typeof snap.ts).toBe("number")
    expect(snap.ts).toBeLessThanOrEqual(Date.now())
  })

  it("preserves the insertion order of the provided tools", () => {
    const snapshot = server.buildToolDefSnapshot({
      zeta: { description: "z", input: { z: 1 } },
      alpha: { description: "a", input: { a: 1 } },
    })
    expect(snapshot?.fragments.map((f) => f.label)).toEqual(["zeta", "alpha"])
  })

  it("tolerates a definition with no description or input", () => {
    const snapshot = server.buildToolDefSnapshot({ bare: {} })
    expect(snapshot?.fragments).toEqual([
      { label: "bare", tokens: estimateTokens("Tool: bare\nDescription: \nParameters: ") },
    ])
    expect(snapshot?.rawText).toBe("Tool: bare\nDescription: \nParameters: ")
  })
})

// ─── applyToolDefSnapshot ─────────────────────────────────────────────────────
//
// v2 delivers the complete effective tool set for each request, so the fold
// replaces (never accumulates) the session's snapshot and clears a stale entry
// when the request sent no tools.

describe("applyToolDefSnapshot", () => {
  const bash = { description: "Run a command", input: { type: "object" } }
  const read = { description: "Read a file", input: { type: "string" } }

  it("stores a snapshot for a new session and reports a change", () => {
    const store: Record<string, ToolDefSnapshot> = {}
    const changed = server.applyToolDefSnapshot(store, "s1", { bash })

    expect(changed).toBe(true)
    expect(store.s1).toBeDefined()
    expect(store.s1.fragments.map((f) => f.label)).toEqual(["bash"])
    expect(store.s1.rawText).toBe(server.buildToolDefText("bash", bash))
    expect(store.s1.t).toBe(estimateTokens(server.buildToolDefText("bash", bash)))
  })

  it("replaces the stored snapshot when the effective tool set changes", () => {
    const store: Record<string, ToolDefSnapshot> = {}
    server.applyToolDefSnapshot(store, "s1", { bash })
    const first = store.s1

    const changed = server.applyToolDefSnapshot(store, "s1", { read })

    expect(changed).toBe(true)
    expect(store.s1).not.toBe(first)
    expect(store.s1.fragments.map((f) => f.label)).toEqual(["read"])
    expect(store.s1.rawText).toBe(server.buildToolDefText("read", read))
  })

  it("reports no change and keeps the stored object when the set is identical", () => {
    const store: Record<string, ToolDefSnapshot> = {}
    server.applyToolDefSnapshot(store, "s1", { bash })
    const before = store.s1

    const changed = server.applyToolDefSnapshot(store, "s1", { bash })

    expect(changed).toBe(false)
    expect(store.s1).toBe(before)
  })

  it("clears a stale snapshot when the request sends no tools", () => {
    const store: Record<string, ToolDefSnapshot> = {}
    server.applyToolDefSnapshot(store, "s1", { bash })

    expect(server.applyToolDefSnapshot(store, "s1", {})).toBe(true)
    expect(store.s1).toBeUndefined()

    // `undefined` is the same complete-empty signal and re-clears nothing.
    server.applyToolDefSnapshot(store, "s2", { bash })
    expect(server.applyToolDefSnapshot(store, "s2", undefined)).toBe(true)
    expect(store.s2).toBeUndefined()
  })

  it("is a no-op when the request sends no tools and no snapshot exists", () => {
    const store: Record<string, ToolDefSnapshot> = {}

    expect(server.applyToolDefSnapshot(store, "s1", {})).toBe(false)
    expect(server.applyToolDefSnapshot(store, "s1", undefined)).toBe(false)
    expect(store).toEqual({})
  })

  it("leaves unrelated sessions untouched when updating or clearing one", () => {
    const store: Record<string, ToolDefSnapshot> = {}
    server.applyToolDefSnapshot(store, "other", { read })
    const otherBefore = store.other

    server.applyToolDefSnapshot(store, "s1", { bash })
    expect(store.other).toBe(otherBefore)

    server.applyToolDefSnapshot(store, "s1", undefined)
    expect(store.other).toBe(otherBefore)
    expect(store.other.fragments.map((f) => f.label)).toEqual(["read"])
  })
})

// ─── mergeSystemSnapshot ──────────────────────────────────────────────────────

/** Build a text whose char/4 estimate is exactly `tokens`. */
function textWithTokens(tokens: number): string {
  return "a".repeat(tokens * 4)
}

describe("mergeSystemSnapshot", () => {
  it("stores the first measurement and reports a change", () => {
    const store: Record<string, SystemSnapshot> = {}
    const allText = textWithTokens(100)
    const changed = server.mergeSystemSnapshot(store, "s1", allText, 1000)

    expect(changed).toBe(true)
    expect(store.s1.t).toBe(100)
    expect(store.s1.ts).toBe(1000)
    expect(store.s1.rawText).toBe(allText)
    expect(store.s1.fragments).toEqual(splitSystemFragments(allText))
  })

  it("treats an identical measurement inside the refresh window as no change", () => {
    const allText = textWithTokens(100)
    const store: Record<string, SystemSnapshot> = {
      s1: { t: 100, ts: 1000, fragments: [{ label: "x", tokens: 100 }], rawText: allText },
    }
    const changed = server.mergeSystemSnapshot(store, "s1", allText, 1000 + 1000)

    expect(changed).toBe(false)
    expect(store.s1.ts).toBe(1000)
    expect(store.s1.rawText).toBe(allText)
  })

  it("refreshes the timestamp once the refresh window has elapsed", () => {
    const allText = textWithTokens(100)
    const store: Record<string, SystemSnapshot> = {
      s1: { t: 100, ts: 1000, fragments: [{ label: "x", tokens: 100 }], rawText: allText },
    }
    const now = 1000 + 5 * 60 * 1000
    const changed = server.mergeSystemSnapshot(store, "s1", allText, now)

    expect(changed).toBe(true)
    expect(store.s1.ts).toBe(now)
  })

  it("treats drift exactly at the threshold (32) as no material change", () => {
    const store: Record<string, SystemSnapshot> = {
      s1: { t: 100, ts: 1000, fragments: [{ label: "x", tokens: 100 }], rawText: textWithTokens(100) },
    }
    const changed = server.mergeSystemSnapshot(store, "s1", textWithTokens(132), 2000)
    expect(changed).toBe(false)
    expect(store.s1.t).toBe(100)
    expect(store.s1.ts).toBe(1000)
  })

  it("replaces the measurement when drift exceeds the threshold", () => {
    const store: Record<string, SystemSnapshot> = {
      s1: { t: 100, ts: 1000, fragments: [{ label: "x", tokens: 100 }], rawText: textWithTokens(100) },
    }
    const newText = textWithTokens(133)
    const changed = server.mergeSystemSnapshot(store, "s1", newText, 2000)

    expect(changed).toBe(true)
    expect(store.s1.t).toBe(133)
    expect(store.s1.ts).toBe(2000)
    expect(store.s1.rawText).toBe(newText)
    expect(store.s1.fragments).toEqual(splitSystemFragments(newText))
  })

  it("backfills rawText/fragments on a legacy entry within drift", () => {
    const allText = textWithTokens(100)
    const store: Record<string, SystemSnapshot> = {
      s1: { t: 100, ts: 1000 },
    }
    const changed = server.mergeSystemSnapshot(store, "s1", allText, 2000)

    expect(changed).toBe(true)
    expect(store.s1.rawText).toBe(allText)
    expect(store.s1.fragments).toEqual(splitSystemFragments(allText))
    expect(store.s1.ts).toBe(2000)
    // The backfill branch keeps the previously stored total.
    expect(store.s1.t).toBe(100)
  })

  it("backfills when fragments exist but are empty", () => {
    const allText = textWithTokens(100)
    const store: Record<string, SystemSnapshot> = {
      s1: { t: 100, ts: 1000, fragments: [], rawText: "stale" },
    }
    const changed = server.mergeSystemSnapshot(store, "s1", allText, 2000)

    expect(changed).toBe(true)
    expect(store.s1.rawText).toBe(allText)
    expect(store.s1.fragments).toEqual(splitSystemFragments(allText))
  })

  it("replaces a sharply smaller measurement (compaction) with the new value", () => {
    const store: Record<string, SystemSnapshot> = {
      s1: { t: 1000, ts: 1000, fragments: [{ label: "x", tokens: 1000 }], rawText: textWithTokens(1000) },
    }
    const compacted = textWithTokens(100)
    const changed = server.mergeSystemSnapshot(store, "s1", compacted, 2000)

    expect(changed).toBe(true)
    expect(store.s1.t).toBe(100)
    expect(store.s1.rawText).toBe(compacted)
    expect(store.s1.ts).toBe(2000)
  })

  it("does not treat a measurement exactly at 70% as compaction", () => {
    const store: Record<string, SystemSnapshot> = {
      s1: { t: 100, ts: 1000, fragments: [{ label: "x", tokens: 100 }], rawText: textWithTokens(100) },
    }
    // 70 tokens is exactly 70% of 100: `70 < 70` is false, and the 30-token
    // drift is within threshold, so nothing changes.
    const changed = server.mergeSystemSnapshot(store, "s1", textWithTokens(70), 2000)
    expect(changed).toBe(false)
    expect(store.s1.t).toBe(100)
  })

  it("treats one token below the 70% line as compaction", () => {
    const store: Record<string, SystemSnapshot> = {
      s1: { t: 100, ts: 1000, fragments: [{ label: "x", tokens: 100 }], rawText: textWithTokens(100) },
    }
    const changed = server.mergeSystemSnapshot(store, "s1", textWithTokens(69), 2000)
    expect(changed).toBe(true)
    expect(store.s1.t).toBe(69)
  })

  it("keeps unrelated sessions intact when updating one", () => {
    const store: Record<string, SystemSnapshot> = {
      other: { t: 5, ts: 1, fragments: [{ label: "o", tokens: 5 }], rawText: "other" },
    }
    server.mergeSystemSnapshot(store, "s1", textWithTokens(100), 1000)
    expect(store.other).toEqual({
      t: 5,
      ts: 1,
      fragments: [{ label: "o", tokens: 5 }],
      rawText: "other",
    })
  })

  it("stores the provided timestamp rather than wall-clock time", () => {
    const store: Record<string, SystemSnapshot> = {}
    server.mergeSystemSnapshot(store, "s1", textWithTokens(10), 42)
    expect(store.s1.ts).toBe(42)
  })
})
