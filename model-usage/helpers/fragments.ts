import type { SystemFragment } from "../types"
import { estimateTokens } from "./tokens"

/**
 * Split an assembled system prompt into labelled fragments by
 * plugin-injected `Instructions from:` markers (e.g. persona-injector,
 * legacy jungle-mode), file-reference markers, and XML-like section
 * blocks (`<available_references>`, `<mcp_instructions>`,
 * `<available_skills>`). Each fragment's tokens are estimated with
 * char/4. Pure / testable.
 */

// Markers that indicate a plugin-injected section (prepended by server
// plugins via `experimental.chat.system.transform`). These sections are
// collected until the boundary before the original system prompt.
// File-reference markers (AGENTS.md paths) are NOT plugin injections —
// they are regular section headers.
const PLUGIN_INJECTION_MARKER = /^(jungle-mode\/|persona-injector)/

// Standard opencode agent preambles that start the base system prompt
// following a plugin-injected section. Fallback boundary signal when the
// injected persona prompt does not end with a trailing newline (single
// blank line separator instead of the usual two).
const AGENT_PREAMBLE = /^(You are opencode, an interactive CLI tool|You are the \*\*Lead Coordinator Agent\*\*)/

export function splitSystemFragments(systemText: string, maxFragments = 100): SystemFragment[] {
  if (!systemText || systemText.trim().length === 0) return []
  const lines = systemText.split("\n")
  const buckets: { label: string; text: string }[] = []
  let current: { label: string; text: string } | null = null
  let xmlMode = false
  let xmlCloseTag = ""
  let pluginMode = false
  let pluginBlankCount = 0

  let hasCreatedAnyBucket = false
  let afterPluginMode = false

  // Top-level XML sections in the assembled system prompt (system.ts,
  // skill.ts). Only these three tags start a new fragment; inner tags
  // like <example>, <server>, <reference>, <skill> are content.
  const sectionOpen = /^<(available_references|mcp_instructions|available_skills)>/
  const friendlyLabel: Record<string, string> = {
    available_references: "References",
    mcp_instructions: "MCP Instructions",
    available_skills: "Skills",
  }

  // Section-starting lines that can never be persona content — hitting one
  // means the plugin section has ended.
  const isSectionStarter = (l: string) => /^Instructions from:\s*(.+)$/.test(l) || sectionOpen.test(l)

  const push = () => {
    if (current && current.text.trim().length > 0) {
      buckets.push(current)
    }
    current = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Inside a multi-line XML block: collect until the closing tag.
    if (xmlMode) {
      current!.text += line + "\n"
      if (line.includes(xmlCloseTag)) {
        push()
        xmlMode = false
      }
      continue
    }

    // Inside a plugin-injected section (e.g. persona-injector persona):
    // collect everything until the boundary with the original system
    // prompt. Headers within this section (like `## 🍌 JUNGLE MODE ACTIVE 🍌`)
    // are content, not separate fragments.
    if (pluginMode) {
      // A new section marker always ends the plugin section — process the
      // line as its own fragment below.
      if (isSectionStarter(line)) {
        push()
        pluginMode = false
        afterPluginMode = true
      } else if (AGENT_PREAMBLE.test(line)) {
        // The injected persona ended WITHOUT a blank-line separator (single
        // `\n` join on persona-injector's side) — the agent preamble line
        // IS the start of the base system prompt. End the section and let
        // the line start the "Agent System Prompt" fragment below.
        push()
        pluginMode = false
        afterPluginMode = true
      } else if (line.trim().length === 0) {
        current!.text += line + "\n"
        pluginBlankCount++
        // Boundary: two consecutive blank lines (persona prompt ends with
        // a trailing newline), or a single blank line followed by the next
        // section (persona prompt without trailing newline).
        const next = lines[i + 1]
        const atBoundary =
          pluginBlankCount >= 2 ||
          (next !== undefined && (AGENT_PREAMBLE.test(next) || isSectionStarter(next)))
        if (atBoundary) {
          push()
          pluginMode = false
          afterPluginMode = true
        }
      } else {
        current!.text += line + "\n"
        pluginBlankCount = 0
      }
      if (pluginMode) continue
    }

    // XML block start (section-level only).
    const xmlMatch = sectionOpen.exec(line)
    if (xmlMatch) {
      const tag = xmlMatch[1]
      push()
      current = { label: friendlyLabel[tag] ?? tag.replace(/_/g, " "), text: line + "\n" }
      hasCreatedAnyBucket = true
      afterPluginMode = false
      xmlCloseTag = `</${tag}>`
      if (line.includes(xmlCloseTag)) {
        push()
      } else {
        xmlMode = true
      }
      continue
    }

    const jungle = /^Instructions from:\s*(.+)$/.exec(line)
    if (jungle) {
      push()
      const rawLabel = jungle[1].trim()
      const label = rawLabel.length > 48 ? rawLabel.slice(0, 47) + "…" : rawLabel
      current = { label, text: line + "\n" }
      hasCreatedAnyBucket = true
      afterPluginMode = false
      // Only enter plugin mode for plugin-injected markers (collect until
      // the section boundary). Other Instructions from: lines (e.g.
      // AGENTS.md file references) are regular section headers — don't
      // swallow their content into plugin mode.
      if (PLUGIN_INJECTION_MARKER.test(jungle[1].trim())) {
        pluginMode = true
        pluginBlankCount = 0
      }
    } else if (current) {
      current.text += line + "\n"
    } else {
      // current is null. This is a marker-less line.
      let label = ""
      if (!hasCreatedAnyBucket) {
        label = "Agent System Prompt"
        hasCreatedAnyBucket = true
      } else if (afterPluginMode) {
        label = "Agent System Prompt"
        afterPluginMode = false
      } else {
        label = "other_markerless"
      }
      current = { label, text: line + "\n" }
    }
  }
  push()

  const frags: SystemFragment[] = []
  let otherMarkerlessTokens = 0

  for (const b of buckets) {
    const tokens = estimateTokens(b.text)
    if (tokens <= 0) continue

    if (b.label === "other_markerless") {
      otherMarkerlessTokens += tokens
    } else {
      frags.push({
        label: b.label || "section",
        tokens,
      })
    }
  }

  if (otherMarkerlessTokens > 0) {
    frags.push({
      label: "Other",
      tokens: otherMarkerlessTokens,
    })
  }

  if (frags.length <= maxFragments) return frags.sort((a, b) => b.tokens - a.tokens)

  const sorted = frags.sort((a, b) => b.tokens - a.tokens)
  const kept = sorted.slice(0, maxFragments)
  const otherTotal = sorted.slice(maxFragments).reduce((s, f) => s + f.tokens, 0)
  if (otherTotal > 0) kept.push({ label: "… more", tokens: otherTotal })
  return kept
}
