export const MS_PER_DAY = 86_400_000

export function getMonthInfo(year?: number, month?: number): { startMs: number; endMs: number; label: string } {
  const now = new Date()
  const y = year ?? now.getUTCFullYear()
  const m = month ?? now.getUTCMonth()
  const startMs = Date.UTC(y, m, 1)
  const endMs = Date.UTC(y, m + 1, 1)
  const label = new Date(Date.UTC(y, m, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  return { startMs, endMs, label }
}

export function isCurrentMonth(startMs: number): boolean {
  const now = new Date()
  const currentStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  return startMs === currentStart
}

export function getWeekMonday(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay()
  const diff = day === 0 ? 6 : day - 1
  d.setUTCDate(d.getUTCDate() - diff)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

export function getWeekInfo(date: Date): { startMs: number; endMs: number; label: string } {
  const monday = getWeekMonday(date)
  const startMs = monday.getTime()
  const endMs = startMs + 7 * MS_PER_DAY

  const startLabel = monday.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
  const sunday = new Date(endMs - 1)
  const endLabel = sunday.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

  return { startMs, endMs, label: `${startLabel} – ${endLabel}` }
}

export function computeMinOffsets(earliestMs: number | null, now: Date): { minMonthOffset: number; minWeekOffset: number; minDayOffset: number } {
  if (earliestMs == null) {
    return { minMonthOffset: 0, minWeekOffset: 0, minDayOffset: 0 }
  }
  const earliestDate = new Date(earliestMs)
  const earliestYear = earliestDate.getUTCFullYear()
  const earliestMonth = earliestDate.getUTCMonth()
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth()
  const monthsBack = (currentYear * 12 + currentMonth) - (earliestYear * 12 + earliestMonth)
  const minMonthOffset = monthsBack === 0 ? 0 : -monthsBack

  const earliestWeekMonday = getWeekMonday(earliestDate).getTime()
  const currentWeekMonday = getWeekMonday(now).getTime()
  let minWeekOffset = 0
  if (earliestWeekMonday < currentWeekMonday) {
    const diffWeeks = Math.floor((currentWeekMonday - earliestWeekMonday) / (7 * MS_PER_DAY))
    minWeekOffset = -diffWeeks
  }

  const earliestDayStart = Date.UTC(earliestDate.getUTCFullYear(), earliestDate.getUTCMonth(), earliestDate.getUTCDate())
  const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  let minDayOffset = 0
  if (earliestDayStart < currentDayStart) {
    const diffDays = Math.floor((currentDayStart - earliestDayStart) / MS_PER_DAY)
    minDayOffset = -diffDays
  }

  return { minMonthOffset, minWeekOffset, minDayOffset }
}

/** UTC number of days in a month. Defaults to the current UTC month; leap-year safe. */
export function getDaysInMonth(year?: number, month?: number): number {
  const now = new Date()
  const y = year ?? now.getUTCFullYear()
  const m = month ?? now.getUTCMonth()
  const lastDay = new Date(Date.UTC(y, m + 1, 0))
  return Math.round((lastDay.getTime() - Date.UTC(y, m, 0)) / MS_PER_DAY)
}

/** 1-based UTC day of month. Defaults to the current date. */
export function getDayOfMonth(now?: Date): number {
  return (now ?? new Date()).getUTCDate()
}

/** Last day of the current UTC month formatted as short-month + day, e.g. "Aug 31". */
export function getMonthEndLabel(now?: Date): string {
  const d = now ?? new Date()
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const lastDay = new Date(Date.UTC(y, m + 1, 0))
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(lastDay)
}
