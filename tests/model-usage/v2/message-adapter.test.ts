import { describe, it, expect } from "bun:test"
import { toLegacyMessages } from "@model-usage/v2/message-adapter"

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
