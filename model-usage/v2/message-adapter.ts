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

/**
 * OpenCode 2.0.27 `PromptFileSource` — the structured provenance of a user
 * attachment (`@opencode/client/promise` generated types):
 * `{ type: "inline" } | { type: "uri"; uri: string }`.
 * Kept open so unknown future members still round-trip losslessly.
 */
export interface V2PromptFileSource {
  readonly type: string
  readonly uri?: string
  readonly [key: string]: unknown
}

/** OpenCode 2.0.27 `PromptMention`: the `@file` token location in the prompt. */
export interface V2PromptMention {
  readonly text?: string
  readonly start?: number
  readonly end?: number
}

/**
 * OpenCode 2.0.27 `PromptFileAttachment` (a member of `SessionMessageUser.files`).
 * Real attachments carry base64 `data`, a `mime`, a structured `source`, and
 * optionally a `name`/`description`/`mention` — the exact shape this adapter
 * must preserve rather than collapsing to `{ type: "file" }`.
 */
export interface V2PromptFileAttachment {
  readonly data?: string
  readonly mime?: string
  readonly source?: V2PromptFileSource | string
  readonly name?: string
  readonly description?: string
  readonly mention?: V2PromptMention
}

export interface V2Message {
  readonly id?: string
  readonly type?: string
  readonly text?: string
  readonly files?: readonly V2PromptFileAttachment[]
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
  /**
   * Legacy string carriers (`source`/`content`/`text`) still flow through as
   * strings. A real v2 `PromptFileAttachment` instead carries the structured
   * `PromptFileSource` (`{ type: "inline" } | { type: "uri"; uri }`) so nothing
   * is lost; `analyze-domain` reads the displayable string from `text`.
   */
  source?: string | V2PromptFileSource
  content?: string
  /** Base64 payload of a v2 `PromptFileAttachment` (`PromptBase64`). */
  data?: string
  /** MIME type of a v2 attachment. */
  mime?: string
  /** Original attachment name (v2 `PromptFileAttachment.name`). */
  filename?: string
  /** Human description (v2 `PromptFileAttachment.description`). */
  description?: string
  /** `@file` mention metadata of a v2 attachment. */
  mention?: V2PromptMention
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

/**
 * Normalize a structured `PromptFileSource`.
 *
 * Lossless: the raw members are spread through first, then the required `type`
 * is normalized, so unknown/future members survive the round-trip instead of
 * being dropped by a `{ type, uri }` reconstruction.
 */
function normalizeFileSource(source: unknown): V2PromptFileSource | undefined {
  if (!source || typeof source !== "object") return undefined
  const s = source as Record<string, unknown>
  const type = typeof s.type === "string" ? s.type : "inline"
  return { ...s, type }
}

/** Normalize a `PromptMention`, preserving its text + offsets when present. */
function normalizeMention(mention: unknown): V2PromptMention | undefined {
  if (!mention || typeof mention !== "object") return undefined
  const m = mention as Record<string, unknown>
  const out: { text?: string; start?: number; end?: number } = {}
  if (typeof m.text === "string") out.text = m.text
  if (typeof m.start === "number") out.start = m.start
  if (typeof m.end === "number") out.end = m.end
  return out
}

/**
 * Map one OpenCode 2.0.27 `PromptFileAttachment` onto the legacy file part.
 *
 * Real attachments (`source` object and/or `data`/`mime`) keep their structured
 * `source` (losslessly, unknown members included), base64 `data`, `mime`,
 * `filename` (`name`), `description`, and `mention`. A derived `text` label is
 * added so the analyze domain can still account for the attachment (mention
 * text → filename → uri).
 *
 * Objects that instead carry a plain string carrier (pre-2.0.27 shapes, ad-hoc
 * input) fall back to the previous `source`/`content`/`text`/`path`/`uri`
 * precedence. Non-objects and empty carriers yield `null` / `{ type: "file" }`
 * exactly as before.
 */
export function mapFileAttachment(raw: unknown): LegacyPart | null {
  if (!raw || typeof raw !== "object") return null
  const f = raw as V2PromptFileAttachment

  const source = normalizeFileSource(f.source)
  const data = typeof f.data === "string" ? f.data : undefined
  const mime = typeof f.mime === "string" ? f.mime : undefined
  const name = typeof f.name === "string" ? f.name : undefined
  const description = typeof f.description === "string" ? f.description : undefined
  const mention = normalizeMention(f.mention)

  const isStructured = source !== undefined || data !== undefined || mime !== undefined
  if (isStructured) {
    const label = mention?.text ?? name ?? (source?.type === "uri" ? source.uri : undefined)
    return {
      type: "file",
      ...(source ? { source } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(mime !== undefined ? { mime } : {}),
      ...(name !== undefined ? { filename: name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(mention ? { mention } : {}),
      ...(label ? { text: label } : {}),
    }
  }

  // Legacy/defensive: plain string carriers only.
  const carrier = [f.source, (f as Record<string, unknown>).content, (f as Record<string, unknown>).text, (f as Record<string, unknown>).path, (f as Record<string, unknown>).uri].find(
    (v) => typeof v === "string" && v.length > 0,
  )
  return { type: "file", ...(carrier ? { source: carrier as string } : {}) }
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
    const part = mapFileAttachment(raw)
    if (part) parts.push(part)
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
