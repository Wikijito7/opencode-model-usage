import { describe, expect, it } from "bun:test"
import { fmtCompact, fmtCostPerMillion } from "@model-usage/helpers/format"

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
