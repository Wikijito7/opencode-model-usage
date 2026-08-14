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
    expect(fmtCompact(-1500)).toBe("-1k") // JS Math.round(-1.5) = -1
    expect(fmtCompact(-1501)).toBe("-2k")
    expect(fmtCompact(-45230)).toBe("-45k")
  })

  it("handles very large values without an 'm' tier", () => {
    expect(fmtCompact(1_000_000)).toBe("1000k")
    expect(fmtCompact(12_345_678)).toBe("12346k")
    expect(fmtCompact(-5_500_000)).toBe("-5500k")
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
