/**
 * model-usage — v2 message adapter (pure).
 *
 * OpenCode 2.0.27 exposes session messages as a flat, discriminated union
 * (`@opencode/client` `SessionMessageInfo`): assistant messages carry their
 * token/cost telemetry and a `content` array, user messages carry `text` and
 * attachments, compaction is its own message type.
 *
 * The analyze domain (`analyze-domain.ts`) and its helpers were written
 * against the v1 shape `{ id, info: { role, providerID, modelID, tokens, cost },
 * parts: [...] }`. Rather than rewrite that tested, host-free domain layer,
 * this module maps the v2 shape onto it. Keeping the mapping here means:
 *
 *  - the domain layer stays independent of `@opencode/client`, and
 *  - the mapping itself is a pure function that unit tests can pin directly.
 *
 * No host API, no SolidJS — only structural types so `bun:test` can import it.
 */

// ─── v2 structural input (subset actually consumed) ──────────────────────────

export interface V2ModelRef {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export interface V2Tokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export interface V2ToolContent {
  readonly type: string
  readonly text?: string
  readonly uri?: string
}

export interface V2ToolState {
  readonly status?: string
  readonly input?: Record<string, unknown>
  readonly content?: readonly V2ToolContent[]
  readonly metadata?: Record<string, unknown>
}

export interface V2AssistantContent {
  readonly type: string
  readonly text?: string
  readonly name?: string
  readonly state?: V2ToolState
}

export interface V2Message {
  readonly id?: string
  readonly type?: string
  readonly text?: string
  readonly files?: readonly unknown[]
  readonly model?: V2ModelRef
  readonly tokens?: V2Tokens
  readonly cost?: number
  readonly content?: readonly V2AssistantContent[]
}

// ─── legacy shapes consumed by analyze-domain / helpers ──────────────────────

export interface LegacyMessageInfo {
  role: string
  providerID?: string
  modelID?: string
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  cost?: number
  [key: string]: unknown
}

export interface LegacyPart {
  type: string
  text?: string
  synthetic?: boolean
  tool?: string
  state?: {
    status?: string
    output?: string
    input?: unknown
    title?: string
  }
  source?: string
  content?: string
  arguments?: unknown
  call?: { arguments?: unknown }
  [key: string]: unknown
}

export interface LegacyMessage {
  id?: string
  info: LegacyMessageInfo
  parts: LegacyPart[]
}

// ─── mapping ─────────────────────────────────────────────────────────────────

function toolOutput(content: readonly V2ToolContent[] | undefined): string {
  if (!content) return ""
  return content
    .map((c) => (c.type === "text" ? c.text ?? "" : c.uri ?? ""))
    .filter((s) => s.length > 0)
    .join("\n")
}

function mapAssistant(m: V2Message): LegacyMessage {
  const parts: LegacyPart[] = []
  for (const c of m.content ?? []) {
    if (c.type === "text") {
      parts.push({ type: "text", text: c.text ?? "" })
    } else if (c.type === "reasoning") {
      parts.push({ type: "reasoning", text: c.text ?? "" })
    } else if (c.type === "tool") {
      const title = c.state?.metadata?.title
      parts.push({
        type: "tool",
        tool: c.name,
        state: {
          status: c.state?.status,
          output: toolOutput(c.state?.content),
          input: c.state?.input,
          ...(typeof title === "string" ? { title } : {}),
        },
      })
    }
  }
  return {
    ...(m.id ? { id: m.id } : {}),
    info: {
      role: "assistant",
      ...(m.model?.providerID ? { providerID: m.model.providerID } : {}),
      ...(m.model?.id ? { modelID: m.model.id } : {}),
      ...(m.tokens ? { tokens: m.tokens } : {}),
      cost: m.cost ?? 0,
    },
    parts,
  }
}

function mapUser(m: V2Message): LegacyMessage {
  const parts: LegacyPart[] = []
  if (typeof m.text === "string" && m.text.length > 0) {
    parts.push({ type: "text", text: m.text })
  }
  for (const raw of m.files ?? []) {
    // v1 file parts exposed a text-bearing field (`source`/`content`/`text`).
    // v2 attachments are opaque here; map any string carrier defensively.
    if (raw && typeof raw === "object") {
      const f = raw as Record<string, unknown>
      const carrier = [f.source, f.content, f.text, f.path, f.uri].find((v) => typeof v === "string")
      parts.push({ type: "file", ...(carrier ? { source: carrier as string } : {}) })
    }
  }
  return { ...(m.id ? { id: m.id } : {}), info: { role: "user" }, parts }
}

/**
 * Convert a v2 session-message list into the legacy `{ info, parts }` shape.
 *
 * - assistant → role "assistant" with token/cost telemetry and mapped parts
 * - user → role "user" with text/file parts
 * - compaction → a synthetic user message carrying a `compaction` part, which
 *   `resolveCompactionEvents` counts and the analyze loop skips (mirrors v1,
 *   where compaction arrived as a part on a message)
 * - all other message kinds (model-selected, idle, …) are ignored
 */
export function toLegacyMessages(messages: readonly unknown[]): LegacyMessage[] {
  const out: LegacyMessage[] = []
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue
    const m = raw as V2Message
    switch (m.type) {
      case "assistant":
        out.push(mapAssistant(m))
        break
      case "user":
        out.push(mapUser(m))
        break
      case "compaction":
        out.push({ ...(m.id ? { id: m.id } : {}), info: { role: "user" }, parts: [{ type: "compaction" }] })
        break
      default:
        break
    }
  }
  return out
}
