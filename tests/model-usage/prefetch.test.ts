import { describe, it, expect } from "bun:test"
import { prefetchTarget, modelCacheKey } from "@model-usage/usage-domain"
import { MS_PER_DAY } from "@model-usage/cache"

// ─── prefetchTarget ─────────────────────────────────────────────────────────────
// Locks issue #14: the prefetch target is a PURE function of (startMs, gran).
// It must be driven by the granularity captured at schedule time, not by any
// live signal (clock, "today", etc.). All cases below use fixed timestamps so the
// suite is deterministic and timer-free.

describe("prefetchTarget", () => {
  // Fixed reference: 2026-01-15 00:00 UTC.
  const START = Date.UTC(2026, 0, 15)

  it('gran "month" advances to the first day of the next month', () => {
    const nextStart = Date.UTC(2026, 1, 1) // 2026-02-01
    const nextEnd = Date.UTC(2026, 2, 1) // 2026-03-01
    const target = prefetchTarget(START, "month")

    expect(target.nextStart).toBe(nextStart)
    expect(target.nextEnd).toBe(nextEnd)
    expect(target.nextKey).toBe(modelCacheKey("month", nextStart))
  })

  it('gran "week" advances by exactly 7 * MS_PER_DAY', () => {
    const nextStart = START + 7 * MS_PER_DAY
    const nextEnd = nextStart + 7 * MS_PER_DAY
    const target = prefetchTarget(START, "week")

    expect(target.nextStart).toBe(nextStart)
    expect(target.nextEnd).toBe(nextEnd)
    expect(target.nextKey).toBe(modelCacheKey("week", nextStart))
  })

  it('gran "day" advances by exactly MS_PER_DAY', () => {
    const nextStart = START + MS_PER_DAY
    const nextEnd = nextStart + MS_PER_DAY
    const target = prefetchTarget(START, "day")

    expect(target.nextStart).toBe(nextStart)
    expect(target.nextEnd).toBe(nextEnd)
    expect(target.nextKey).toBe(modelCacheKey("day", nextStart))
  })

  // Regression guard (key test): the output is driven by the passed `gran`,
  // not by anything external. This proves prefetchTarget branches on its
  // `gran` argument — the schedule-time granularity — which is exactly the
  // property issue #14 fixed.
  it("is a pure function of (startMs, gran): branching on gran, not any live signal", () => {
    const week = prefetchTarget(START, "week")
    const month = prefetchTarget(START, "month")

    // Different granularity ⇒ different prefetch target for the same startMs.
    expect(week.nextKey).not.toBe(month.nextKey)

    // The week target is exactly reproducible from (START, "week") alone.
    const weekStart = START + 7 * MS_PER_DAY
    expect(week.nextStart).toBe(weekStart)
    expect(week.nextEnd).toBe(weekStart + 7 * MS_PER_DAY)
    expect(week.nextKey).toBe(modelCacheKey("week", weekStart))
  })

  it('gran "month" rolls over the year across December → January', () => {
    // December 15, 2026 → the next month is January 2027 (year rollover).
    const startMs = Date.UTC(2026, 11, 15)
    const nextStart = Date.UTC(2027, 0, 1) // 2027-01-01
    const nextEnd = Date.UTC(2027, 1, 1) // 2027-02-01
    const target = prefetchTarget(startMs, "month")

    expect(target.nextStart).toBe(nextStart)
    expect(target.nextEnd).toBe(nextEnd)
    expect(target.nextKey).toBe(modelCacheKey("month", nextStart))
  })
})