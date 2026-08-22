import { describe, expect, it } from "bun:test"
import {
  ANALYZE_EXPORT_FORMATS,
  buildAnalyzeExport,
  buildAnalyzeExportData,
  buildJson,
  buildMarkdown,
  buildText,
  type AnalyzeExportData,
} from "@model-usage/helpers/export/analyze"
import { EXPORT_FORMATS, type ExportFormat } from "@model-usage/wlib/src/core/export"
import type { AnalysisData } from "@model-usage/analyze-domain"
import type { ModelStat } from "@model-usage/helpers/models"

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_ID = "sess-001"

function makeModelStat(partial: Partial<ModelStat> = {}): ModelStat {
  return {
    providerID: "anthropic",
    modelID: "claude-3-5-sonnet",
    msgCount: 8,
    inputTokens: 6000,
    outputTokens: 3000,
    cacheRead: 1000,
    cacheWrite: 500,
    cost: 1.25,
    visibleOutputTokens: 3000,
    lastCallRawPromptTokens: 7000,
    peakInputTokens: 7000,
    ...partial,
  }
}

/** A fully populated AnalysisData exercising every field and section. */
function makeAnalysis(): AnalysisData {
  return {
    categories: [
      {
        name: "SYSTEM",
        totalTokens: 5000,
        entries: [{ label: "System prompt", tokens: 5000 }],
      },
      {
        name: "USER",
        totalTokens: 5000,
        entries: [
          { label: "User #1", tokens: 3000 },
          { label: "User #2", tokens: 2000 },
        ],
      },
      {
        name: "TOOLS",
        totalTokens: 2000,
        entries: [
          { label: "bash", tokens: 1000 },
          { label: "edit", tokens: 1000 },
        ],
      },
    ],
    estimatedTotal: 12000,
    topContributors: [
      { label: "System prompt", tokens: 5000 },
      { label: "User #2", tokens: 3000 },
      { label: "bash", tokens: 1000 },
    ],
    hasToolsSection: true,
    messageCount: 1500,
    modelStats: [
      makeModelStat(),
      makeModelStat({
        providerID: "openai",
        modelID: "gpt-4o",
        msgCount: 2,
        inputTokens: 1000,
        outputTokens: 500,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        peakInputTokens: 1000,
      }),
    ],
    switchesCount: 3,
    compactionSummary: { count: 2, measured: 2, reductionTokens: 8000 },
    sessionCost: 1.25,
    hotspotResults: [
      {
        category: "USER",
        label: "User #2",
        tokens: 3000,
        ratio: 2.5,
        formattedRatio: "2.5",
        preview: "User #2 unusually large message preview",
        fullText: "User #2 unusually large message full text",
      },
    ],
    rawSystemText: "You are a helpful assistant.\nBe concise.",
    rawToolDefsText: "tool bash\n  run a shell command",
    toolDefsTokens: 800,
    syntheticTokens: 200,
  }
}

/** The equivalent already-mapped AnalyzeExportData for the builders. */
function makeData(): AnalyzeExportData {
  return {
    sessionID: SESSION_ID,
    messageCount: 1500,
    estimatedTotal: 12000,
    hasToolsSection: true,
    categories: [
      {
        name: "SYSTEM",
        totalTokens: 5000,
        entries: [{ label: "System prompt", tokens: 5000 }],
      },
      {
        name: "USER",
        totalTokens: 5000,
        entries: [
          { label: "User #1", tokens: 3000 },
          { label: "User #2", tokens: 2000 },
        ],
      },
      {
        name: "TOOLS",
        totalTokens: 2000,
        entries: [
          { label: "bash", tokens: 1000 },
          { label: "edit", tokens: 1000 },
        ],
      },
    ],
    topContributors: [
      { label: "System prompt", tokens: 5000 },
      { label: "User #2", tokens: 3000 },
      { label: "bash", tokens: 1000 },
    ],
    modelStats: [
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 8,
        inputTokens: 6000,
        outputTokens: 3000,
        cacheRead: 1000,
        cacheWrite: 500,
        cost: 1.25,
        peakInputTokens: 7000,
      },
      {
        providerID: "openai",
        modelID: "gpt-4o",
        msgCount: 2,
        inputTokens: 1000,
        outputTokens: 500,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        peakInputTokens: 1000,
      },
    ],
    switchesCount: 3,
    compaction: { count: 2, measured: 2, reductionTokens: 8000 },
    sessionCost: 1.25,
    hotspotResults: [
      { category: "USER", label: "User #2", tokens: 3000, ratio: 2.5, formattedRatio: "2.5" },
    ],
    toolDefsTokens: 800,
    syntheticTokens: 200,
    rawSystemText: "You are a helpful assistant.\nBe concise.",
    rawToolDefsText: "tool bash\n  run a shell command",
  }
}

/** A minimal/empty AnalyzeExportData: every optional section absent. */
function makeEmptyData(): AnalyzeExportData {
  return {
    sessionID: "sess-empty",
    messageCount: 0,
    estimatedTotal: 0,
    hasToolsSection: false,
    categories: [],
    topContributors: [],
    modelStats: [],
    switchesCount: 0,
    compaction: null,
    sessionCost: 0,
    hotspotResults: [],
    toolDefsTokens: 0,
    syntheticTokens: 0,
    rawSystemText: "",
    rawToolDefsText: "",
  }
}

// ─── buildMarkdown ───────────────────────────────────────────────────────────

describe("buildMarkdown", () => {
  it("renders header, estimated total, and every section in order", () => {
    const out = buildMarkdown(makeData())
    const expected = [
      "## Analyze · Session sess-001 · 1,500 messages",
      "",
      "Estimated total: 12,000 tokens",
      "",
      "| Category | Tokens | % |",
      "| --- | ---: | ---: |",
      "| SYSTEM | 5,000 | 41.7% |",
      "| USER | 5,000 | 41.7% |",
      "| TOOLS | 2,000 | 16.7% |",
      "",
      "### SYSTEM",
      "",
      "| Entry | Tokens |",
      "| --- | ---: |",
      "| System prompt | 5,000 |",
      "",
      "### USER",
      "",
      "| Entry | Tokens |",
      "| --- | ---: |",
      "| User #1 | 3,000 |",
      "| User #2 | 2,000 |",
      "",
      "### TOOLS",
      "",
      "| Entry | Tokens |",
      "| --- | ---: |",
      "| bash | 1,000 |",
      "| edit | 1,000 |",
      "",
      "## Top Contributors",
      "",
      "| Entry | Tokens |",
      "| --- | ---: |",
      "| System prompt | 5,000 |",
      "| User #2 | 3,000 |",
      "| bash | 1,000 |",
      "",
      "## Models in Session",
      "",
      "| Provider | Model | Messages | Input | Output | Cache read | Cache write | Peak input | Cost |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      "| anthropic | claude-3-5-sonnet | 8 | 6,000 | 3,000 | 1,000 | 500 | 7,000 | $1.25 |",
      "| openai | gpt-4o | 2 | 1,000 | 500 | 0 | 0 | 1,000 | $0.00 |",
      "",
      "Model switches: 3",
      "",
      "## Compactions",
      "",
      "2, -8,000 tokens",
      "",
      "## Session cost",
      "",
      "$1.25",
      "",
      "## Token Composition",
      "",
      "Tool definitions: 800 tokens",
      "Synthetic content: 200 tokens",
      "",
      "## Unusually Large Messages",
      "",
      "| Category | Label | Tokens | Ratio |",
      "| --- | --- | ---: | ---: |",
      "| USER | User #2 | 3,000 | 2.5x avg |",
      "",
      "## Raw System Prompt",
      "",
      "```",
      "You are a helpful assistant.",
      "Be concise.",
      "```",
      "",
      "## Raw Tool Definitions",
      "",
      "```",
      "tool bash",
      "  run a shell command",
      "```",
    ].join("\n")
    expect(out).toBe(expected)
  })

  it("emits only the header and estimated total when every section is empty", () => {
    const out = buildMarkdown(makeEmptyData())
    expect(out).toBe(
      ["## Analyze · Session sess-empty · 0 messages", "", "Estimated total: 0 tokens", ""].join("\n")
    )
  })

  it("escapes pipes, backslashes, and newlines in category/entry/model/hotspot cells", () => {
    const data = makeData()
    data.categories = [
      {
        name: "Cat|With\\Pipe\nName",
        totalTokens: 10,
        entries: [{ label: "Entry|One\nTwo", tokens: 10 }],
      },
    ]
    data.modelStats = [
      {
        providerID: "Prov|ider",
        modelID: "Model\\x\nY",
        msgCount: 1,
        inputTokens: 1,
        outputTokens: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: 0.1,
        peakInputTokens: 5,
      },
    ]
    data.hotspotResults = [
      { category: "Hot|Cat\n", label: "Lbl", tokens: 10, ratio: 1, formattedRatio: "1.0" },
    ]
    data.estimatedTotal = 10
    data.topContributors = []

    const out = buildMarkdown(data)

    // Category table cell is escaped.
    expect(out).toContain("| Cat\\|With\\\\Pipe\\nName | 10 | 100.0% |")
    // Per-category heading uses the raw name (headings do not need escaping).
    expect(out).toContain("### Cat|With\\Pipe\nName")
    // Entry label is escaped in its table.
    expect(out).toContain("| Entry\\|One\\nTwo | 10 |")
    // Model provider/model cells are escaped.
    expect(out).toContain("| Prov\\|ider | Model\\\\x\\nY |")
    // Hotspot category cell is escaped.
    expect(out).toContain("| Hot\\|Cat\\n | Lbl | 10 | 1.0x avg |")

    // The escaped newlines must not introduce extra physical lines: each
    // escaped cell must begin a single output line (no real newline inside).
    const lines = out.split("\n")
    expect(lines.some((l) => l.startsWith("| Cat\\|With\\\\Pipe\\nName |"))).toBe(true)
    expect(lines.some((l) => l.startsWith("| Entry\\|One\\nTwo |"))).toBe(true)
    expect(lines.some((l) => l.startsWith("| Prov\\|ider | Model\\\\x\\nY |"))).toBe(true)
    expect(lines.some((l) => l.startsWith("| Hot\\|Cat\\n |"))).toBe(true)
  })

  it("renders 0.0% for every category when estimatedTotal is zero (no NaN)", () => {
    const data = makeEmptyData()
    data.categories = [
      { name: "A", totalTokens: 0, entries: [{ label: "a", tokens: 0 }] },
      { name: "B", totalTokens: 0, entries: [{ label: "b", tokens: 0 }] },
    ]
    const out = buildMarkdown(data)
    expect(out).toContain("| A | 0 | 0.0% |")
    expect(out).toContain("| B | 0 | 0.0% |")
    expect(out).not.toContain("NaN")
  })

  it("omits the switches line when switchesCount is zero", () => {
    const data = makeData()
    data.switchesCount = 0
    expect(buildMarkdown(data)).not.toContain("Model switches:")
  })

  it("omits compaction, session cost, token composition, and raw sections when absent", () => {
    const out = buildMarkdown(makeEmptyData())
    expect(out).not.toContain("## Compactions")
    expect(out).not.toContain("## Session cost")
    expect(out).not.toContain("## Token Composition")
    expect(out).not.toContain("## Raw System Prompt")
    expect(out).not.toContain("## Raw Tool Definitions")
  })

  it("shows a pending count when compaction.count exceeds measured", () => {
    const data = makeData()
    data.compaction = { count: 3, measured: 2, reductionTokens: 8000 }
    expect(buildMarkdown(data)).toContain("3, -8,000 tokens (1 pending)")
  })

  it("omits the reduction suffix when reductionTokens is zero", () => {
    const data = makeData()
    data.compaction = { count: 2, measured: 2, reductionTokens: 0 }
    const out = buildMarkdown(data)
    expect(out).toContain("## Compactions")
    // The compaction line shows the count but no ", -X,XXX tokens" suffix.
    expect(out).not.toContain(", -")
  })

  it("omits the compaction section when count is zero", () => {
    const data = makeData()
    data.compaction = { count: 0, measured: 0, reductionTokens: 0 }
    expect(buildMarkdown(data)).not.toContain("## Compactions")
  })

  it("preserves triple newlines inside raw sections (no collapsing)", () => {
    const data = makeData()
    data.rawSystemText = "para one\n\n\npara two"
    data.rawToolDefsText = "tool a\n\n\n  body"
    const out = buildMarkdown(data)
    // The raw system prompt keeps its embedded triple-newline run verbatim.
    expect(out).toContain("para one\n\n\npara two")
    // The raw tool definitions keep their embedded triple-newline run verbatim.
    expect(out).toContain("tool a\n\n\n  body")
  })
})

// ─── buildJson ───────────────────────────────────────────────────────────────

describe("buildJson", () => {
  it("produces valid JSON with every field and full raw text preserved", () => {
    const parsed = JSON.parse(buildJson(makeData())) as {
      sessionID: string
      messageCount: number
      estimatedTotal: number
      hasToolsSection: boolean
      toolDefsTokens: number
      syntheticTokens: number
      sessionCost: number
      categories: Array<{
        name: string
        totalTokens: number
        entries: Array<{ label: string; tokens: number }>
      }>
      topContributors: Array<{ label: string; tokens: number }>
      modelStats: Array<Record<string, unknown>>
      switchesCount: number
      compaction: { count: number; measured: number; reductionTokens: number } | null
      hotspotResults: Array<Record<string, unknown>>
      rawSystemText: string
      rawToolDefsText: string
    }

    expect(parsed.sessionID).toBe("sess-001")
    expect(parsed.messageCount).toBe(1500)
    expect(parsed.estimatedTotal).toBe(12000)
    expect(parsed.hasToolsSection).toBe(true)
    expect(parsed.toolDefsTokens).toBe(800)
    expect(parsed.syntheticTokens).toBe(200)
    expect(parsed.sessionCost).toBe(1.25)
    expect(parsed.switchesCount).toBe(3)

    expect(parsed.categories).toEqual([
      {
        name: "SYSTEM",
        totalTokens: 5000,
        entries: [{ label: "System prompt", tokens: 5000 }],
      },
      {
        name: "USER",
        totalTokens: 5000,
        entries: [
          { label: "User #1", tokens: 3000 },
          { label: "User #2", tokens: 2000 },
        ],
      },
      {
        name: "TOOLS",
        totalTokens: 2000,
        entries: [
          { label: "bash", tokens: 1000 },
          { label: "edit", tokens: 1000 },
        ],
      },
    ])
    expect(parsed.topContributors).toEqual([
      { label: "System prompt", tokens: 5000 },
      { label: "User #2", tokens: 3000 },
      { label: "bash", tokens: 1000 },
    ])
    expect(parsed.modelStats).toEqual([
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 8,
        inputTokens: 6000,
        outputTokens: 3000,
        cacheRead: 1000,
        cacheWrite: 500,
        peakInputTokens: 7000,
        cost: 1.25,
      },
      {
        providerID: "openai",
        modelID: "gpt-4o",
        msgCount: 2,
        inputTokens: 1000,
        outputTokens: 500,
        cacheRead: 0,
        cacheWrite: 0,
        peakInputTokens: 1000,
        cost: 0,
      },
    ])
    expect(parsed.compaction).toEqual({ count: 2, measured: 2, reductionTokens: 8000 })
    expect(parsed.hotspotResults).toEqual([
      { category: "USER", label: "User #2", tokens: 3000, ratio: 2.5, formattedRatio: "2.5" },
    ])
    // Raw text is preserved in full, byte-for-byte, with its embedded newlines.
    expect(parsed.rawSystemText).toBe("You are a helpful assistant.\nBe concise.")
    expect(parsed.rawToolDefsText).toBe("tool bash\n  run a shell command")
  })

  it("emits compaction as null when absent", () => {
    const parsed = JSON.parse(buildJson(makeEmptyData())) as { compaction: unknown }
    expect(parsed.compaction).toBeNull()
  })

  it("emits empty arrays and zero values for empty data", () => {
    const parsed = JSON.parse(buildJson(makeEmptyData())) as {
      categories: unknown[]
      topContributors: unknown[]
      modelStats: unknown[]
      hotspotResults: unknown[]
      toolDefsTokens: number
      syntheticTokens: number
      sessionCost: number
      hasToolsSection: boolean
      rawSystemText: string
      rawToolDefsText: string
    }
    expect(parsed.categories).toEqual([])
    expect(parsed.topContributors).toEqual([])
    expect(parsed.modelStats).toEqual([])
    expect(parsed.hotspotResults).toEqual([])
    expect(parsed.toolDefsTokens).toBe(0)
    expect(parsed.syntheticTokens).toBe(0)
    expect(parsed.sessionCost).toBe(0)
    expect(parsed.hasToolsSection).toBe(false)
    expect(parsed.rawSystemText).toBe("")
    expect(parsed.rawToolDefsText).toBe("")
  })

  it("rounds sessionCost, model cost, and hotspot ratio to two decimals", () => {
    const data = makeData()
    data.sessionCost = 0.125
    data.modelStats = [
      {
        providerID: "anthropic",
        modelID: "claude-round",
        msgCount: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.125,
        peakInputTokens: 1,
      },
    ]
    data.hotspotResults = [
      { category: "USER", label: "Lbl", tokens: 1, ratio: 2.345, formattedRatio: "2.3" },
    ]

    const parsed = JSON.parse(buildJson(data)) as {
      sessionCost: number
      modelStats: Array<{ cost: number }>
      hotspotResults: Array<{ ratio: number }>
    }
    expect(parsed.sessionCost).toBe(0.13)
    expect(parsed.modelStats[0].cost).toBe(0.13)
    // 2.345 → round2 → 2.35
    expect(parsed.hotspotResults[0].ratio).toBe(2.35)
  })
})

// ─── buildText ───────────────────────────────────────────────────────────────

describe("buildText", () => {
  it("renders header, totals, categories, contributors, models, and raw text", () => {
    const out = buildText(makeData())
    const expected = [
      "Analyze · Session sess-001 · 1,500 messages",
      "Estimated total: 12,000 tokens",
      "",
      "SYSTEM — 5,000 tokens (41.7%)",
      "  System prompt  5,000 tokens",
      "",
      "USER — 5,000 tokens (41.7%)",
      "  User #1  3,000 tokens",
      "  User #2  2,000 tokens",
      "",
      "TOOLS — 2,000 tokens (16.7%)",
      "  bash  1,000 tokens",
      "  edit  1,000 tokens",
      "",
      "Top Contributors",
      "   1. System prompt  5,000 tokens",
      "   2. User #2  3,000 tokens",
      "   3. bash  1,000 tokens",
      "",
      "Models in Session",
      "  anthropic / claude-3-5-sonnet — 8 msgs · 6,000 tokens input · 3,000 tokens output · 1,000 cache read · 500 cache write · 7,000 tokens peak input · $1.25",
      "  openai / gpt-4o — 2 msgs · 1,000 tokens input · 500 tokens output · 0 cache read · 0 cache write · 1,000 tokens peak input · $0.00",
      "Model switches: 3",
      "",
      "Compactions: 2, -8,000 tokens",
      "",
      "Session cost: $1.25",
      "",
      "Tool definitions: 800 tokens",
      "Synthetic content: 200 tokens",
      "",
      "Unusually Large Messages",
      "  User #2  3,000 tokens  (2.5x avg)",
      "",
      "Raw System Prompt",
      "----------------------------------------",
      "You are a helpful assistant.",
      "Be concise.",
      "",
      "Raw Tool Definitions",
      "----------------------------------------",
      "tool bash",
      "  run a shell command",
    ].join("\n")
    expect(out).toBe(expected)
  })

  it("renders header + estimated total only when every section is empty", () => {
    expect(buildText(makeEmptyData())).toBe(
      "Analyze · Session sess-empty · 0 messages\nEstimated total: 0 tokens\n"
    )
  })

  it("omits optional sections when absent and never renders markdown syntax", () => {
    const out = buildText(makeEmptyData())
    expect(out).not.toContain("Top Contributors")
    expect(out).not.toContain("Models in Session")
    expect(out).not.toContain("Compactions")
    expect(out).not.toContain("Session cost")
    expect(out).not.toContain("Unusually Large Messages")
    expect(out).not.toContain("Raw System Prompt")
    expect(out).not.toContain("Raw Tool Definitions")
    // Plain text: no markdown table pipes or headings anywhere.
    expect(out).not.toContain("|")
    expect(out).not.toContain("##")
  })

  it("preserves raw text verbatim without markdown escaping", () => {
    const data = makeData()
    data.rawSystemText = "line one\nline | with pipe\n``` not a fence"
    const out = buildText(data)
    expect(out).toContain("line one\nline | with pipe\n``` not a fence")
    // No backslash-escaped pipes in plain text.
    expect(out).not.toContain("\\|")
  })

  it("shows a pending count when compaction.count exceeds measured", () => {
    const data = makeData()
    data.compaction = { count: 3, measured: 2, reductionTokens: 8000 }
    expect(buildText(data)).toContain("Compactions: 3, -8,000 tokens (1 pending)")
  })

  it("omits the switches line when switchesCount is zero", () => {
    const data = makeData()
    data.switchesCount = 0
    expect(buildText(data)).not.toContain("Model switches:")
  })

  it("renders 0.0% for categories when estimatedTotal is zero (no NaN)", () => {
    const data = makeEmptyData()
    data.categories = [{ name: "A", totalTokens: 0, entries: [{ label: "a", tokens: 0 }] }]
    const out = buildText(data)
    expect(out).toContain("A — 0 tokens (0.0%)")
    expect(out).not.toContain("NaN")
  })

  it("preserves triple newlines inside raw sections (no collapsing)", () => {
    const data = makeData()
    data.rawSystemText = "para one\n\n\npara two"
    data.rawToolDefsText = "tool a\n\n\n  body"
    const out = buildText(data)
    // The raw system prompt keeps its embedded triple-newline run verbatim.
    expect(out).toContain("para one\n\n\npara two")
    // The raw tool definitions keep their embedded triple-newline run verbatim.
    expect(out).toContain("tool a\n\n\n  body")
  })
})

// ─── buildAnalyzeExport dispatcher ───────────────────────────────────────────

describe("buildAnalyzeExport dispatcher", () => {
  const data = makeData()

  it("dispatches markdown to buildMarkdown", () => {
    expect(buildAnalyzeExport("markdown", data)).toBe(buildMarkdown(data))
  })

  it("dispatches json to buildJson", () => {
    expect(buildAnalyzeExport("json", data)).toBe(buildJson(data))
  })

  it("dispatches text to buildText", () => {
    expect(buildAnalyzeExport("text", data)).toBe(buildText(data))
  })

  it("rejects CSV explicitly", () => {
    expect(() => buildAnalyzeExport("csv", data)).toThrow(
      "Analyze export does not support CSV"
    )
  })

  it("throws for an unknown format", () => {
    expect(() => buildAnalyzeExport("xml" as never, data)).toThrow()
  })
})

// ─── ANALYZE_EXPORT_FORMATS ──────────────────────────────────────────────────

describe("ANALYZE_EXPORT_FORMATS", () => {
  it("contains 3 entries and excludes CSV", () => {
    expect(ANALYZE_EXPORT_FORMATS).toHaveLength(3)
    expect(ANALYZE_EXPORT_FORMATS.map((f) => f.id)).toEqual(["markdown", "json", "text"])
    expect(ANALYZE_EXPORT_FORMATS.map((f) => f.label)).toEqual([
      "Markdown",
      "JSON",
      "Plain text",
    ])
    expect(ANALYZE_EXPORT_FORMATS.some((f) => f.id === "csv")).toBe(false)
  })

  it("is a strict subset of EXPORT_FORMATS preserving order", () => {
    expect(EXPORT_FORMATS.map((f) => f.id)).toEqual(["markdown", "csv", "json", "text"])
    const exportIds = new Set(EXPORT_FORMATS.map((f) => f.id))
    for (const f of ANALYZE_EXPORT_FORMATS) {
      expect(exportIds.has(f.id)).toBe(true)
    }
  })
})

// ─── buildAnalyzeExportData ──────────────────────────────────────────────────

describe("buildAnalyzeExportData", () => {
  it("maps every AnalysisData field to AnalyzeExportData", () => {
    const analysis = makeAnalysis()
    const result = buildAnalyzeExportData(analysis, SESSION_ID)

    expect(result.sessionID).toBe(SESSION_ID)
    expect(result.messageCount).toBe(1500)
    expect(result.estimatedTotal).toBe(12000)
    expect(result.hasToolsSection).toBe(true)
    expect(result.switchesCount).toBe(3)
    expect(result.sessionCost).toBe(1.25)
    expect(result.toolDefsTokens).toBe(800)
    expect(result.syntheticTokens).toBe(200)

    // Categories: name, totalTokens, and nested entries are all mapped.
    expect(result.categories).toEqual([
      {
        name: "SYSTEM",
        totalTokens: 5000,
        entries: [{ label: "System prompt", tokens: 5000 }],
      },
      {
        name: "USER",
        totalTokens: 5000,
        entries: [
          { label: "User #1", tokens: 3000 },
          { label: "User #2", tokens: 2000 },
        ],
      },
      {
        name: "TOOLS",
        totalTokens: 2000,
        entries: [
          { label: "bash", tokens: 1000 },
          { label: "edit", tokens: 1000 },
        ],
      },
    ])

    expect(result.topContributors).toEqual([
      { label: "System prompt", tokens: 5000 },
      { label: "User #2", tokens: 3000 },
      { label: "bash", tokens: 1000 },
    ])

    // Model stats carry every mapped field (incl. peakInputTokens, cost).
    expect(result.modelStats).toEqual([
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 8,
        inputTokens: 6000,
        outputTokens: 3000,
        cacheRead: 1000,
        cacheWrite: 500,
        cost: 1.25,
        peakInputTokens: 7000,
      },
      {
        providerID: "openai",
        modelID: "gpt-4o",
        msgCount: 2,
        inputTokens: 1000,
        outputTokens: 500,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        peakInputTokens: 1000,
      },
    ])

    expect(result.compaction).toEqual({ count: 2, measured: 2, reductionTokens: 8000 })
    expect(result.hotspotResults).toEqual([
      { category: "USER", label: "User #2", tokens: 3000, ratio: 2.5, formattedRatio: "2.5" },
    ])

    // Raw text is carried through in full, unmodified.
    expect(result.rawSystemText).toBe(analysis.rawSystemText)
    expect(result.rawToolDefsText).toBe(analysis.rawToolDefsText)
  })

  it("preserves long raw texts in full (no truncation)", () => {
    const analysis = makeAnalysis()
    const systemText = "start\n" + "x".repeat(10000) + "\nend"
    const toolDefsText = "tool a\n" + "y".repeat(8000)
    analysis.rawSystemText = systemText
    analysis.rawToolDefsText = toolDefsText

    const result = buildAnalyzeExportData(analysis, SESSION_ID)
    expect(result.rawSystemText).toBe(systemText)
    expect(result.rawToolDefsText).toBe(toolDefsText)
  })

  it("returns empty arrays and zero values for empty AnalysisData", () => {
    const analysis: AnalysisData = {
      categories: [],
      estimatedTotal: 0,
      topContributors: [],
      hasToolsSection: false,
      messageCount: 0,
      modelStats: [],
      switchesCount: 0,
      compactionSummary: null,
      sessionCost: 0,
      hotspotResults: [],
      rawSystemText: "",
      rawToolDefsText: "",
      toolDefsTokens: 0,
      syntheticTokens: 0,
    }

    const result = buildAnalyzeExportData(analysis, "sess-empty")
    expect(result.sessionID).toBe("sess-empty")
    expect(result.messageCount).toBe(0)
    expect(result.estimatedTotal).toBe(0)
    expect(result.hasToolsSection).toBe(false)
    expect(result.categories).toEqual([])
    expect(result.topContributors).toEqual([])
    expect(result.modelStats).toEqual([])
    expect(result.hotspotResults).toEqual([])
    expect(result.switchesCount).toBe(0)
    expect(result.sessionCost).toBe(0)
    expect(result.toolDefsTokens).toBe(0)
    expect(result.syntheticTokens).toBe(0)
    expect(result.rawSystemText).toBe("")
    expect(result.rawToolDefsText).toBe("")
  })

  it("maps a null compactionSummary to null", () => {
    const analysis = makeAnalysis()
    analysis.compactionSummary = null
    expect(buildAnalyzeExportData(analysis, SESSION_ID).compaction).toBeNull()
  })

  it("maps a non-null compactionSummary to an object", () => {
    const analysis = makeAnalysis()
    analysis.compactionSummary = { count: 1, measured: 1, reductionTokens: 500 }
    expect(buildAnalyzeExportData(analysis, SESSION_ID).compaction).toEqual({
      count: 1,
      measured: 1,
      reductionTokens: 500,
    })
  })

  it("passes toolDefsTokens and syntheticTokens through unchanged", () => {
    const analysis = makeAnalysis()
    analysis.toolDefsTokens = 1234
    analysis.syntheticTokens = 567
    const result = buildAnalyzeExportData(analysis, SESSION_ID)
    expect(result.toolDefsTokens).toBe(1234)
    expect(result.syntheticTokens).toBe(567)
  })

  it("maps topContributors and hotspotResults entries faithfully", () => {
    const analysis = makeAnalysis()
    analysis.topContributors = [
      { label: "a", tokens: 1 },
      { label: "b", tokens: 2 },
    ]
    analysis.hotspotResults = [
      {
        category: "USER",
        label: "hot",
        tokens: 99,
        ratio: 4.2,
        formattedRatio: "4.2",
        preview: "hot message preview",
        fullText: "hot message full text",
      },
    ]
    const result = buildAnalyzeExportData(analysis, SESSION_ID)
    expect(result.topContributors).toEqual([
      { label: "a", tokens: 1 },
      { label: "b", tokens: 2 },
    ])
    expect(result.hotspotResults).toEqual([
      { category: "USER", label: "hot", tokens: 99, ratio: 4.2, formattedRatio: "4.2" },
    ])
  })

  it("does not mutate the input AnalysisData (raw text unchanged)", () => {
    const analysis = makeAnalysis()
    const systemBefore = analysis.rawSystemText
    const toolBefore = analysis.rawToolDefsText
    buildAnalyzeExportData(analysis, SESSION_ID)
    expect(analysis.rawSystemText).toBe(systemBefore)
    expect(analysis.rawToolDefsText).toBe(toolBefore)
  })
})
