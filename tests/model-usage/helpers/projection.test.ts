import { describe, expect, it } from "bun:test"
import { projectBurnRate, MIN_ELAPSED_DAYS } from "@model-usage/helpers/projection"

// ─── projectBurnRate ──────────────────────────────────────────────────────────

describe("projectBurnRate", () => {
  it("returns null when elapsedDays is 0", () => {
    expect(projectBurnRate(10, 0, 31)).toBeNull()
  })

  it("returns null when elapsedDays is negative", () => {
    expect(projectBurnRate(10, -1, 31)).toBeNull()
  })

  it("returns null when totalDays is 0", () => {
    expect(projectBurnRate(10, 10, 0)).toBeNull()
  })

  it("returns null when totalDays is negative", () => {
    expect(projectBurnRate(10, 10, -31)).toBeNull()
  })

  it("day 1 extrapolation: used=10 over 1 day in a 31-day month → 310", () => {
    const result = projectBurnRate(10, 1, 31)
    expect(result).toEqual({ projected: 310, pct: 310 })
  })

  it("zero usage rate → projected and pct are both 0", () => {
    const result = projectBurnRate(0, 10, 31)
    expect(result).toEqual({ projected: 0, pct: 0 })
  })

  it("negative used clamps to zero", () => {
    const result = projectBurnRate(-5, 10, 31)
    expect(result).toEqual({ projected: 0, pct: 0 })
  })

  it("full month (elapsed === total) projects exactly the used amount", () => {
    const result = projectBurnRate(42, 31, 31)
    expect(result).toEqual({ projected: 42, pct: 42 })
  })

  it("overshoot is NOT clamped at 100 (no upper clamp)", () => {
    const result = projectBurnRate(60, 10, 20)
    expect(result).toEqual({ projected: 120, pct: 120 })
  })

  it("computes fractional results precisely", () => {
    // 12.5 / 5 * 31 = 77.5
    const result = projectBurnRate(12.5, 5, 31)
    expect(result!.projected).toBeCloseTo(77.5, 5)
    expect(result!.pct).toBeCloseTo(77.5, 5)
  })

  it("returns null when used is NaN", () => {
    expect(projectBurnRate(NaN, 10, 31)).toBeNull()
  })

  it("returns null when elapsedDays is NaN", () => {
    expect(projectBurnRate(10, NaN, 31)).toBeNull()
  })

  it("returns null when totalDays is NaN", () => {
    expect(projectBurnRate(10, 10, NaN)).toBeNull()
  })

  it("returns null when used is Infinity", () => {
    expect(projectBurnRate(Infinity, 10, 31)).toBeNull()
  })

  it("returns null when elapsedDays is Infinity", () => {
    expect(projectBurnRate(10, Infinity, 31)).toBeNull()
  })

  it("returns null when totalDays is Infinity", () => {
    expect(projectBurnRate(10, 10, Infinity)).toBeNull()
  })

  it("MIN_ELAPSED_DAYS equals 3", () => {
    expect(MIN_ELAPSED_DAYS).toBe(3)
  })
})
