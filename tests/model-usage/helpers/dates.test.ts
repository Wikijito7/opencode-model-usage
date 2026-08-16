import { describe, expect, it } from "bun:test"
import { computeMinOffsets, getWeekMonday, getWeekInfo, getDaysInMonth, getDayOfMonth, getMonthEndLabel } from "@model-usage/helpers/dates"
import { formatPercentDiff } from "@model-usage/helpers/format"

describe("getWeekMonday", () => {
  it("a known Monday returns itself", () => {
    const d = new Date(Date.UTC(2026, 6, 6))
    const monday = getWeekMonday(d)
    const expected = Date.UTC(2026, 6, 6)
    expect(monday.getTime()).toBe(expected)
  })

  it("a Tuesday returns the previous Monday", () => {
    const d = new Date(Date.UTC(2026, 6, 7))
    const monday = getWeekMonday(d)
    expect(monday.getTime()).toBe(Date.UTC(2026, 6, 6))
  })

  it("a Sunday returns the previous Monday (same week)", () => {
    const d = new Date(Date.UTC(2026, 6, 12))
    const monday = getWeekMonday(d)
    expect(monday.getTime()).toBe(Date.UTC(2026, 6, 6))
  })

  it("month boundary: Jul 1 2026 (Wednesday) → Jun 29 2026 (Monday)", () => {
    const d = new Date(Date.UTC(2026, 6, 1))
    const monday = getWeekMonday(d)
    expect(monday.getTime()).toBe(Date.UTC(2026, 5, 29))
  })

  it("year boundary: Jan 1 2026 (Thursday) → Dec 29 2025 (Monday)", () => {
    const d = new Date(Date.UTC(2026, 0, 1))
    const monday = getWeekMonday(d)
    expect(monday.getTime()).toBe(Date.UTC(2025, 11, 29))
  })

  it("multiple dates in the same week return the same Monday", () => {
    const mon = getWeekMonday(new Date(Date.UTC(2026, 6, 6)))
    const wed = getWeekMonday(new Date(Date.UTC(2026, 6, 8)))
    const sun = getWeekMonday(new Date(Date.UTC(2026, 6, 12)))
    expect(wed.getTime()).toBe(mon.getTime())
    expect(sun.getTime()).toBe(mon.getTime())
  })

  it("edge case: date at exactly 00:00 UTC", () => {
    const d = new Date(Date.UTC(2026, 6, 6, 0, 0, 0, 0))
    const monday = getWeekMonday(d)
    expect(monday.getTime()).toBe(Date.UTC(2026, 6, 6))
  })
})

describe("getWeekInfo", () => {
  it("returns correct startMs (Monday 00:00 UTC)", () => {
    const info = getWeekInfo(new Date(Date.UTC(2026, 6, 8)))
    expect(info.startMs).toBe(Date.UTC(2026, 6, 6))
  })

  it("returns correct endMs (startMs + 7 days)", () => {
    const info = getWeekInfo(new Date(Date.UTC(2026, 6, 8)))
    expect(info.endMs).toBe(Date.UTC(2026, 6, 13))
  })

  it('label format: "Jul 6 – Jul 12" for a July week', () => {
    const info = getWeekInfo(new Date(Date.UTC(2026, 6, 6)))
    expect(info.label).toBe("Jul 6 – Jul 12")
  })

  it('cross-month week label: "Jun 29 – Jul 5" when week straddles months', () => {
    const info = getWeekInfo(new Date(Date.UTC(2026, 5, 29)))
    expect(info.label).toBe("Jun 29 – Jul 5")
  })

  it("current date returns the current week's info", () => {
    const now = new Date()
    const info = getWeekInfo(now)
    expect(info.startMs).toBeLessThanOrEqual(now.getTime())
    expect(info.endMs).toBeGreaterThan(now.getTime())
    expect(info.endMs - info.startMs).toBe(7 * 24 * 60 * 60 * 1000)
    expect(typeof info.label).toBe("string")
    expect(info.label.length).toBeGreaterThan(0)
  })
})

describe("computeMinOffsets", () => {
  // computeMinOffsets returns clean integers (0 instead of -0). Assert exact
  // values directly so a regression back to -0 fails loudly.
  function assertOffsets(earliestMs: number | null, now: Date, expected: { minMonthOffset: number; minWeekOffset: number; minDayOffset: number }) {
    const result = computeMinOffsets(earliestMs, now)
    expect(result.minMonthOffset).toBe(expected.minMonthOffset)
    expect(result.minWeekOffset).toBe(expected.minWeekOffset)
    expect(result.minDayOffset).toBe(expected.minDayOffset)
  }

  it("earliestMs is null → all offsets are 0", () => {
    const now = new Date(Date.UTC(2026, 6, 15))
    assertOffsets(null, now, { minMonthOffset: 0, minWeekOffset: 0, minDayOffset: 0 })
  })

  it("earliestMs in the same month/week/day as now → all offsets are 0", () => {
    const now = new Date(Date.UTC(2026, 6, 6))
    assertOffsets(Date.UTC(2026, 6, 6), now, { minMonthOffset: 0, minWeekOffset: 0, minDayOffset: 0 })
  })

  it("earliestMs one month earlier (same day) → month offset -1 with correct week/day deltas", () => {
    // earliest = Mon Jun 15 2026, now = Wed Jul 15 2026
    const now = new Date(Date.UTC(2026, 6, 15))
    assertOffsets(Date.UTC(2026, 5, 15), now, { minMonthOffset: -1, minWeekOffset: -4, minDayOffset: -30 })
  })

  it("cross-year boundary: Dec previous year → Jan current year → month offset -1", () => {
    // earliest = Mon Dec 1 2025, now = Mon Jan 5 2026
    const now = new Date(Date.UTC(2026, 0, 5))
    assertOffsets(Date.UTC(2025, 11, 1), now, { minMonthOffset: -1, minWeekOffset: -5, minDayOffset: -35 })
  })

  it("several months back: Jan 2026 → Jul 2026 → month offset -6", () => {
    // earliest = Mon Jan 5 2026, now = Mon Jul 6 2026 (182 days apart)
    const now = new Date(Date.UTC(2026, 6, 6))
    assertOffsets(Date.UTC(2026, 0, 5), now, { minMonthOffset: -6, minWeekOffset: -26, minDayOffset: -182 })
  })

  it("earliest three days ago → day offset -3", () => {
    // earliest = Sun Jul 12 2026, now = Wed Jul 15 2026
    const now = new Date(Date.UTC(2026, 6, 15))
    assertOffsets(Date.UTC(2026, 6, 12), now, { minMonthOffset: 0, minWeekOffset: -1, minDayOffset: -3 })
  })

  it("earliest on the same day → day offset 0", () => {
    const now = new Date(Date.UTC(2026, 6, 15))
    assertOffsets(Date.UTC(2026, 6, 15), now, { minMonthOffset: 0, minWeekOffset: 0, minDayOffset: 0 })
  })

  it("earliest in the previous week (same weekday) → week offset -1", () => {
    // earliest = Mon Jul 6 2026, now = Mon Jul 13 2026
    const now = new Date(Date.UTC(2026, 6, 13))
    assertOffsets(Date.UTC(2026, 6, 6), now, { minMonthOffset: 0, minWeekOffset: -1, minDayOffset: -7 })
  })

  it("Sunday before a Monday counts as the previous week (getWeekMonday rollback)", () => {
    // earliest = Sun Jul 12 2026 (rolls back to Mon Jul 6), now = Mon Jul 13 2026
    const now = new Date(Date.UTC(2026, 6, 13))
    assertOffsets(Date.UTC(2026, 6, 12), now, { minMonthOffset: 0, minWeekOffset: -1, minDayOffset: -1 })
  })
})

describe("formatPercentDiff", () => {
  it("current > previous: shows ▲ with positive percent", () => {
    expect(formatPercentDiff(150, 100)).toEqual({ arrow: "▲", text: "+50%" })
  })

  it("current < previous: shows ▼ with negative percent", () => {
    expect(formatPercentDiff(50, 100)).toEqual({ arrow: "▼", text: "-50%" })
  })

  it("no change: shows — for both arrow and text", () => {
    expect(formatPercentDiff(100, 100)).toEqual({ arrow: "—", text: "—" })
  })

  it("previous is null: shows — for both arrow and text", () => {
    expect(formatPercentDiff(100, null)).toEqual({ arrow: "—", text: "—" })
  })

  it("previous is 0: shows — (avoid division by zero)", () => {
    expect(formatPercentDiff(100, 0)).toEqual({ arrow: "—", text: "—" })
  })

  it("large increase: current=1000, previous=10 → +9900%", () => {
    expect(formatPercentDiff(1000, 10)).toEqual({ arrow: "▲", text: "+9900%" })
  })

  it("very small decrease: current=99, previous=100 → -1%", () => {
    expect(formatPercentDiff(99, 100)).toEqual({ arrow: "▼", text: "-1%" })
  })

  it("current=0, previous=100 → -100%", () => {
    expect(formatPercentDiff(0, 100)).toEqual({ arrow: "▼", text: "-100%" })
  })
})

// ─── getDaysInMonth ───────────────────────────────────────────────────────────

describe("getDaysInMonth", () => {
  it("Feb 2026 → 28 days", () => {
    expect(getDaysInMonth(2026, 1)).toBe(28)
  })

  it("Feb 2024 (leap year) → 29 days", () => {
    expect(getDaysInMonth(2024, 1)).toBe(29)
  })

  it("Aug 2026 → 31 days", () => {
    expect(getDaysInMonth(2026, 7)).toBe(31)
  })

  it("Apr 2026 → 30 days", () => {
    expect(getDaysInMonth(2026, 3)).toBe(30)
  })

  it("defaults to the current UTC month and returns 28–31 days", () => {
    const result = getDaysInMonth()
    expect(result).toBeGreaterThanOrEqual(28)
    expect(result).toBeLessThanOrEqual(31)
  })
})

// ─── getDayOfMonth ────────────────────────────────────────────────────────────

describe("getDayOfMonth", () => {
  it("returns the 1-based UTC day of month (mid-month)", () => {
    expect(getDayOfMonth(new Date(Date.UTC(2026, 7, 15)))).toBe(15)
  })

  it("returns 1 for the first day of the month", () => {
    expect(getDayOfMonth(new Date(Date.UTC(2026, 7, 1)))).toBe(1)
  })
})

// ─── getMonthEndLabel ─────────────────────────────────────────────────────────

describe("getMonthEndLabel", () => {
  it('formats the last day of a 31-day month (Aug 2026 → "Aug 31")', () => {
    expect(getMonthEndLabel(new Date(Date.UTC(2026, 7, 15)))).toBe("Aug 31")
  })

  it('formats the last day of a 31-day month (Jan 2026 → "Jan 31")', () => {
    expect(getMonthEndLabel(new Date(Date.UTC(2026, 0, 10)))).toBe("Jan 31")
  })

  it('formats the last day of a leap-year February (Feb 2024 → "Feb 29")', () => {
    expect(getMonthEndLabel(new Date(Date.UTC(2024, 1, 10)))).toBe("Feb 29")
  })
})
