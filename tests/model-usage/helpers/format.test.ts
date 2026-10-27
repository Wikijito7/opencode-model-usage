import { describe, expect, it } from "bun:test"
import {
  fmtCompact,
  fmtCostPerMillion,
  getProjectionColor,
  getUsageColor,
} from "@model-usage/helpers/format"

// ─── fmtCompact ──────────────────────────────────────────────────────────────

describe("fmtCompact", () => {
  it("returns small values (< 1000) as-is", () => {
    expect(fmtCompact(0)).toBe("0")
    expect(fmtCompact(999)).toBe("999")
    expect(fmtCompact(-999)).toBe("-999")
    expect(fmtCompact(123)).toBe("123")
    expect(fmtCompact(-123)).toBe("-123")
  })

  it("rounds values >= 1000 to the nearest thousand and appends 'k'", () => {
    expect(fmtCompact(1000)).toBe("1k")
    expect(fmtCompact(1499)).toBe("1k")
    expect(fmtCompact(1500)).toBe("2k")
    expect(fmtCompact(45230)).toBe("45k")
    expect(fmtCompact(100500)).toBe("101k")
  })

  it("handles negative values >= 1000 preserving sign and rounding logic", () => {
    expect(fmtCompact(-1000)).toBe("-1k")
    expect(fmtCompact(-1499)).toBe("-1k")
    // abs-based rounding: |−1500| rounds to 2, sign preserved
    expect(fmtCompact(-1500)).toBe("-2k")
    expect(fmtCompact(-1501)).toBe("-2k")
    expect(fmtCompact(-45230)).toBe("-45k")
  })

  it("formats values >= 1,000,000 to one-decimal 'M' values, dropping trailing '.0'", () => {
    expect(fmtCompact(1_000_000)).toBe("1M")
    expect(fmtCompact(1_500_000)).toBe("1.5M")
    expect(fmtCompact(1_250_000)).toBe("1.3M")
    expect(fmtCompact(-1_500_000)).toBe("-1.5M")
  })

  it("rolls k-tier values up to the M tier at the boundary", () => {
    expect(fmtCompact(999_999)).toBe("1M")
  })
})

// ─── fmtCostPerMillion ───────────────────────────────────────────────────────

describe("fmtCostPerMillion", () => {
  it('formats a cost per million with exactly two decimals and "/1M" suffix', () => {
    expect(fmtCostPerMillion(3.4)).toBe("$3.40/1M")
  })

  it("formats zero as $0.00/1M", () => {
    expect(fmtCostPerMillion(0)).toBe("$0.00/1M")
  })

  it("rounds values needing more than two decimals", () => {
    expect(fmtCostPerMillion(1.23456)).toBe("$1.23/1M")
  })

  it("rounds up values needing rounding", () => {
    expect(fmtCostPerMillion(2.999)).toBe("$3.00/1M")
  })
})


// ─── getUsageColor (v1 thresholds) ───────────────────────────────────────────

describe("getUsageColor", () => {
  it("locks the unchanged v1 green/yellow/red thresholds", () => {
    expect(getUsageColor(0)).toBe("#22c55e")
    expect(getUsageColor(75)).toBe("#22c55e")
    expect(getUsageColor(75.1)).toBe("#eab308")
    expect(getUsageColor(90)).toBe("#eab308")
    expect(getUsageColor(90.1)).toBe("#ef4444")
    expect(getUsageColor(100)).toBe("#ef4444")
    expect(getUsageColor(101)).toBe("#ef4444")
    expect(getUsageColor(150)).toBe("#ef4444")
  })

  it("uses provided semantic tokens and preserves RGBA objects", () => {
    const success = { r: 0.1, g: 0.8, b: 0.2, a: 1 }
    const red = { r: 0.9, g: 0.1, b: 0.1 }
    const colors = { success, warning: "SENTINEL_WARNING", red }

    expect(getUsageColor(10, colors)).toBe(success)
    expect(getUsageColor(80, colors)).toBe("SENTINEL_WARNING")
    expect(getUsageColor(95, colors)).toBe(red)
  })

  it("falls back to stable green/yellow when optional tokens are missing", () => {
    expect(getUsageColor(10, { red: "SENTINEL_RED" })).toBe("#22c55e")
    expect(getUsageColor(80, { red: "SENTINEL_RED" })).toBe("#eab308")
    expect(getUsageColor(95, { red: "SENTINEL_RED" })).toBe(
      "SENTINEL_RED",
    )
    expect(
      getUsageColor(80, { success: "SENTINEL_SUCCESS" }),
    ).toBe("#eab308")
    expect(
      getUsageColor(95, {
        success: "SENTINEL_SUCCESS",
        warning: "SENTINEL_WARNING",
      }),
    ).toBe("#ef4444")
  })
})

describe("getProjectionColor", () => {
  it("uses success at/below 100 and red above 100 with legacy fallbacks", () => {
    expect(getProjectionColor(0)).toBe("#22c55e")
    expect(getProjectionColor(100)).toBe("#22c55e")
    expect(getProjectionColor(100.1)).toBe("#ef4444")
    expect(getProjectionColor(150)).toBe("#ef4444")
  })

  it("uses provided semantic tokens and falls back for missing tokens", () => {
    const success = { r: 0.1, g: 0.8, b: 0.2 }
    const red = { r: 0.9, g: 0.1, b: 0.1, a: 1 }

    expect(getProjectionColor(99, { success, red })).toBe(success)
    expect(getProjectionColor(101, { success, red })).toBe(red)
    expect(getProjectionColor(99, { red })).toBe("#22c55e")
    expect(getProjectionColor(101, { success })).toBe("#ef4444")
  })
})
