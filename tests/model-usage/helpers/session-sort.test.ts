import { describe, expect, it } from "bun:test"
import { toggleSessionSort, clampScrollTop } from "@model-usage/helpers/session-sort"

// ─── toggleSessionSort ───────────────────────────────────────────────────────

describe("toggleSessionSort", () => {
  it("toggles tokens → cost", () => {
    expect(toggleSessionSort("tokens")).toBe("cost")
  })

  it("toggles cost → tokens", () => {
    expect(toggleSessionSort("cost")).toBe("tokens")
  })

  it("never returns price across multiple toggles (stays in 2-value set)", () => {
    let current: "tokens" | "cost" = "tokens"
    for (let i = 0; i < 50; i++) {
      current = toggleSessionSort(current)
      expect(["tokens", "cost"]).toContain(current)
      expect(current).not.toBe("price")
    }
    // even count of toggles returns to the start
    expect(current).toBe("tokens")
  })

  it("is a true 2-stop cycle (odd toggles land on cost)", () => {
    expect(toggleSessionSort(toggleSessionSort(toggleSessionSort("tokens")))).toBe("cost")
  })
})

// ─── clampScrollTop ───────────────────────────────────────────────────────────

describe("clampScrollTop", () => {
  it("clamps scrollTop below 0 up to 0", () => {
    expect(clampScrollTop(-50, 1000, 100)).toBe(0)
  })

  it("clamps scrollTop above max down to max", () => {
    // max = 1000 - 100 = 900
    expect(clampScrollTop(5000, 1000, 100)).toBe(900)
  })

  it("passes through a valid mid value", () => {
    expect(clampScrollTop(400, 1000, 100)).toBe(400)
  })

  it("clamps to 0 when the content fits (maxScroll 0)", () => {
    expect(clampScrollTop(50, 100, 100)).toBe(0)
    expect(clampScrollTop(50, 80, 100)).toBe(0)
  })

  it("returns 0 for undefined/NaN scrollHeight", () => {
    expect(Number.isNaN(clampScrollTop(50, Number.NaN, 100))).toBe(false)
    expect(clampScrollTop(50, Number.NaN, 100)).toBe(0)
    expect(clampScrollTop(50, undefined as unknown as number, 100)).toBe(0)
  })

  it("treats undefined/NaN viewHeight as 0 (maxScroll = scrollHeight, value passes through)", () => {
    expect(Number.isNaN(clampScrollTop(50, 1000, Number.NaN))).toBe(false)
    // viewHeight 0 → maxScroll = 1000 - 0 = 1000, so 50 is within range
    expect(clampScrollTop(50, 1000, Number.NaN)).toBe(50)
    expect(clampScrollTop(50, 1000, undefined as unknown as number)).toBe(50)
  })

  it("returns 0 for undefined/NaN scrollTop", () => {
    expect(Number.isNaN(clampScrollTop(Number.NaN, 1000, 100))).toBe(false)
    expect(clampScrollTop(Number.NaN, 1000, 100)).toBe(0)
    expect(clampScrollTop(undefined as unknown as number, 1000, 100)).toBe(0)
  })

  it("never returns NaN for any combination of non-finite inputs", () => {
    expect(clampScrollTop(Number.NaN, Number.NaN, Number.NaN)).toBe(0)
    expect(Number.isNaN(clampScrollTop(Number.NaN, Number.NaN, Number.NaN))).toBe(false)
  })
})
