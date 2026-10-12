import { describe, it, expect } from "bun:test"
import { toLegacyMessages, mapFileAttachment } from "@model-usage/v2/message-adapter"

// ─── toLegacyMessages: assistant mapping ─────────────────────────────────────

describe("toLegacyMessages", () => {
  it("returns an empty array for an empty input", () => {
    expect(toLegacyMessages([])).toEqual([])
  })

  it("skips non-object entries (null, undefined, primitives, arrays)", () => {
    const messages = [
      null,
      undefined,
      42,
      "assistant",
      [],
      { type: "assistant" },
    ]
    const out = toLegacyMessages(messages)
    expect(out).toHaveLength(1)
    expect(out[0].info.role).toBe("assistant")
  })

  it("maps an assistant message with text, reasoning and tool parts in order", () => {
    const out = toLegacyMessages([
      {
        id: "a1",
        type: "assistant",
        model: { id: "claude", providerID: "anthropic", variant: "x" },
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        cost: 0.5,
        content: [
          { type: "text", text: "hello" },
          { type: "reasoning", text: "think" },
          {
            type: "tool",
            name: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              content: [
                { type: "text", text: "out" },
                { type: "image", uri: "http://x/y" },
              ],
              metadata: { title: "Run ls" },
            },
          },
        ],
      },
    ])

    expect(out).toHaveLength(1)
    const msg = out[0]
    expect(msg.id).toBe("a1")
    expect(msg.info).toEqual({
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude",
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      cost: 0.5,
    })
    expect(msg.parts).toEqual([
      { type: "text", text: "hello" },
      { type: "reasoning", text: "think" },
      {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          output: "out\nhttp://x/y",
          input: { cmd: "ls" },
          title: "Run ls",
        },
      },
    ])
  })

  it("defaults assistant cost to 0 and omits model/tokens when absent", () => {
    const out = toLegacyMessages([{ type: "assistant" }])
    expect(out).toHaveLength(1)
    const info = out[0].info
    expect(info.role).toBe("assistant")
    expect(info.cost).toBe(0)
    expect(info).not.toHaveProperty("providerID")
    expect(info).not.toHaveProperty("modelID")
    expect(info).not.toHaveProperty("tokens")
    expect(out[0]).not.toHaveProperty("id")
  })

  it("omits providerID/modelID independently when only one is present", () => {
    const out = toLegacyMessages([
      { type: "assistant", model: { id: "m" } },
      { type: "assistant", model: { providerID: "p" } },
    ])
    const [first, second] = out
    expect(first.info.modelID).toBe("m")
    expect(first.info).not.toHaveProperty("providerID")
    // model.id missing → no modelID key; providerID present.
    expect(second.info.providerID).toBe("p")
    expect(second.info).not.toHaveProperty("modelID")
  })

  it("coerces a missing text field on a text part to an empty string", () => {
    const out = toLegacyMessages([
      { type: "assistant", content: [{ type: "text" }, { type: "reasoning" }] },
    ])
    expect(out[0].parts).toEqual([
      { type: "text", text: "" },
      { type: "reasoning", text: "" },
    ])
  })

  it("joins tool output content, keeping only non-empty strings, and filters unknown types", () => {
    const out = toLegacyMessages([
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "read",
            state: {
              status: "completed",
              content: [
                { type: "text", text: "line1" },
                { type: "text", text: "" },
                { type: "file", uri: "file://a" },
                { type: "text", text: "line2" },
              ],
            },
          },
        ],
      },
    ])
    const part = out[0].parts[0]
    expect(part.type).toBe("tool")
    expect(part.state?.output).toBe("line1\nfile://a\nline2")
  })

  it("produces empty tool output for absent or empty content", () => {
    const out = toLegacyMessages([
      { type: "assistant", content: [{ type: "tool", name: "t1" }] },
      { type: "assistant", content: [{ type: "tool", name: "t2", state: { content: [] } }] },
      {
        type: "assistant",
        content: [{ type: "tool", name: "t3", state: { content: [{ type: "text", text: "" }] } }],
      },
    ])
    expect(out[0].parts[0].state?.output).toBe("")
    expect(out[1].parts[0].state?.output).toBe("")
    expect(out[2].parts[0].state?.output).toBe("")
  })

  it("only includes a tool title when the metadata title is a string", () => {
    const out = toLegacyMessages([
      {
        type: "assistant",
        content: [
          { type: "tool", name: "a", state: { metadata: { title: 5 } } },
          { type: "tool", name: "b", state: { metadata: { title: null } } },
          { type: "tool", name: "c", state: { metadata: {} } },
          { type: "tool", name: "d", state: {} },
        ],
      },
    ])
    for (const part of out[0].parts) {
      expect(part.state).not.toHaveProperty("title")
    }
  })

  it("ignores assistant content entries of unknown type", () => {
    const out = toLegacyMessages([
      { type: "assistant", content: [{ type: "step-start" }, { type: "text", text: "ok" }] },
    ])
    expect(out[0].parts).toEqual([{ type: "text", text: "ok" }])
  })

  // ─── user mapping ──────────────────────────────────────────────────────────

  it("maps a user message with text and file attachments", () => {
    const out = toLegacyMessages([
      {
        id: "u1",
        type: "user",
        text: "hi",
        files: [
          { source: "src/a.ts" },
          { content: "c" },
          { text: "t" },
          { path: "p" },
          { uri: "u" },
          {},
        ],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("u1")
    expect(out[0].info).toEqual({ role: "user" })
    expect(out[0].parts).toEqual([
      { type: "text", text: "hi" },
      { type: "file", source: "src/a.ts" },
      { type: "file", source: "c" },
      { type: "file", source: "t" },
      { type: "file", source: "p" },
      { type: "file", source: "u" },
      { type: "file" },
    ])
  })

  it("omits the text part for an empty or missing user text", () => {
    expect(toLegacyMessages([{ type: "user", text: "" }])[0].parts).toEqual([])
    expect(toLegacyMessages([{ type: "user" }])[0].parts).toEqual([])
  })

  it("omits file parts that are not objects and those with an empty-string carrier", () => {
    const out = toLegacyMessages([
      { type: "user", files: [42, null, "str", { source: "" }, { source: 7 }] },
    ])
    // 42/null/"str" are skipped; {source:""} → no source; {source:7} → non-string carrier.
    expect(out[0].parts).toEqual([{ type: "file" }, { type: "file" }])
  })

  it("prefers the first string carrier by field precedence (source > content > text > path > uri)", () => {
    const out = toLegacyMessages([
      { type: "user", files: [{ uri: "u", path: "p", text: "t", content: "c", source: "s" }] },
    ])
    expect(out[0].parts).toEqual([{ type: "file", source: "s" }])
  })

  it("preserves a structured 2.0.27 PromptFileAttachment through toLegacyMessages", () => {
    const out = toLegacyMessages([
      {
        type: "user",
        text: "see attached",
        files: [
          {
            source: { type: "uri", uri: "file:///tmp/report.pdf" },
            data: "JVBERi0=",
            mime: "application/pdf",
            name: "report.pdf",
            description: "Quarterly report",
            mention: { text: "@report.pdf", start: 0, end: 12 },
          },
        ],
      },
    ])
    expect(out[0].parts).toEqual([
      { type: "text", text: "see attached" },
      {
        type: "file",
        source: { type: "uri", uri: "file:///tmp/report.pdf" },
        data: "JVBERi0=",
        mime: "application/pdf",
        filename: "report.pdf",
        description: "Quarterly report",
        mention: { text: "@report.pdf", start: 0, end: 12 },
        text: "@report.pdf",
      },
    ])
  })

  // ─── compaction + unknown message kinds ────────────────────────────────────

  it("maps a compaction message to a synthetic user message carrying a compaction part", () => {
    const out = toLegacyMessages([{ id: "c1", type: "compaction" }])
    expect(out).toEqual([{ id: "c1", info: { role: "user" }, parts: [{ type: "compaction" }] }])
  })

  it("omits id on a compaction message without one", () => {
    const out = toLegacyMessages([{ type: "compaction" }])
    expect(out[0]).not.toHaveProperty("id")
    expect(out[0].parts).toEqual([{ type: "compaction" }])
  })

  it("ignores all non assistant/user/compaction message kinds", () => {
    const out = toLegacyMessages([
      { type: "model-selected", id: "x" },
      { type: "idle", id: "y" },
      { type: "assistant", id: "keep" },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("keep")
  })

  it("preserves input order across mixed message kinds", () => {
    const out = toLegacyMessages([
      { type: "user", id: "u" },
      { type: "idle", id: "skip" },
      { type: "assistant", id: "a" },
      { type: "compaction", id: "c" },
    ])
    expect(out.map((m) => m.id)).toEqual(["u", "a", "c"])
  })
})

// ─── mapFileAttachment: OpenCode 2.0.27 PromptFileAttachment ─────────────────

describe("mapFileAttachment", () => {
  it("preserves an inline source, data, mime and name and derives text from the name", () => {
    expect(
      mapFileAttachment({
        source: { type: "inline" },
        data: "aGVsbG8=",
        mime: "text/plain",
        name: "notes.txt",
      }),
    ).toEqual({
      type: "file",
      source: { type: "inline" },
      data: "aGVsbG8=",
      mime: "text/plain",
      filename: "notes.txt",
      text: "notes.txt",
    })
  })

  it("preserves a URI source and derives text from the uri", () => {
    const part = mapFileAttachment({ source: { type: "uri", uri: "file:///tmp/report.pdf" } })
    expect(part).toEqual({
      type: "file",
      source: { type: "uri", uri: "file:///tmp/report.pdf" },
      text: "file:///tmp/report.pdf",
    })
  })

  it("prefers the mention text for the derived label and keeps the mention metadata", () => {
    expect(
      mapFileAttachment({
        source: { type: "inline" },
        data: "eA==",
        mime: "image/png",
        name: "diagram.png",
        mention: { text: "@diagram.png", start: 3, end: 15 },
      }),
    ).toEqual({
      type: "file",
      source: { type: "inline" },
      data: "eA==",
      mime: "image/png",
      filename: "diagram.png",
      mention: { text: "@diagram.png", start: 3, end: 15 },
      text: "@diagram.png",
    })
  })

  it("treats data/mime alone as structured but derives no text label", () => {
    expect(mapFileAttachment({ data: "abc", mime: "application/octet-stream" })).toEqual({
      type: "file",
      data: "abc",
      mime: "application/octet-stream",
    })
  })

  it("defaults a source without a string type to inline and keeps a string uri", () => {
    expect(mapFileAttachment({ source: { uri: "file:///x" } })).toEqual({
      type: "file",
      source: { type: "inline", uri: "file:///x" },
    })
  })

  it("preserves unknown/future members of a structured source through the round-trip", () => {
    // Losslessness regression: an earlier revision reconstructed the source as
    // `{ type, uri }` and silently dropped every other member. The adapter now
    // spreads the raw source first, so unknown members survive verbatim.
    expect(
      mapFileAttachment({
        source: { type: "uri", uri: "file:///a", extra: "keep", futureFlag: true },
        mime: "text/plain",
      }),
    ).toEqual({
      type: "file",
      source: { type: "uri", uri: "file:///a", extra: "keep", futureFlag: true },
      mime: "text/plain",
      text: "file:///a",
    })
  })

  it("preserves the attachment description alongside the structured fields", () => {
    expect(
      mapFileAttachment({
        source: { type: "inline" },
        data: "aGVsbG8=",
        mime: "text/plain",
        name: "notes.txt",
        description: "Meeting notes",
      }),
    ).toEqual({
      type: "file",
      source: { type: "inline" },
      data: "aGVsbG8=",
      mime: "text/plain",
      filename: "notes.txt",
      description: "Meeting notes",
      text: "notes.txt",
    })
  })

  it("keeps a description on a data/mime-only attachment with no derived label", () => {
    expect(mapFileAttachment({ data: "abc", mime: "application/octet-stream", description: "binary blob" })).toEqual({
      type: "file",
      data: "abc",
      mime: "application/octet-stream",
      description: "binary blob",
    })
  })

  it("drops a description that arrives without any structured source/data/mime", () => {
    // `description` alone does not make an attachment structured; it falls back
    // to the legacy carrier path, which has no slot for it.
    expect(mapFileAttachment({ description: "orphan" })).toEqual({ type: "file" })
  })

  it("keeps a mention's offsets even when its text is absent", () => {
    expect(mapFileAttachment({ mime: "text/plain", mention: { start: 2, end: 5 } })).toEqual({
      type: "file",
      mime: "text/plain",
      mention: { start: 2, end: 5 },
    })
  })

  it("preserves the legacy string carrier with source > content > text > path > uri precedence", () => {
    expect(mapFileAttachment({ uri: "u", path: "p", text: "t", content: "c", source: "s" })).toEqual({
      type: "file",
      source: "s",
    })
    expect(mapFileAttachment({ uri: "u" })).toEqual({ type: "file", source: "u" })
    expect(mapFileAttachment({ path: "p" })).toEqual({ type: "file", source: "p" })
  })

  it("treats a string source as a legacy carrier, not a structured source", () => {
    expect(mapFileAttachment({ source: "src/a.ts" })).toEqual({ type: "file", source: "src/a.ts" })
  })

  it("yields a bare file part for empty or non-string carriers", () => {
    expect(mapFileAttachment({})).toEqual({ type: "file" })
    expect(mapFileAttachment({ source: "" })).toEqual({ type: "file" })
    expect(mapFileAttachment({ source: 7, content: 9 })).toEqual({ type: "file" })
  })

  it("returns null for non-object inputs", () => {
    expect(mapFileAttachment(null)).toBeNull()
    expect(mapFileAttachment(undefined)).toBeNull()
    expect(mapFileAttachment(42)).toBeNull()
    expect(mapFileAttachment("str")).toBeNull()
  })
})
