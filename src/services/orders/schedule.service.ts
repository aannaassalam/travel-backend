/**
 * When a bus or flight route leaves.
 *
 * A route is not one dated departure but a timetable, entered once: a bus
 * leaves at the same times every day (`dailyTimes`), a flight at set times on
 * set days of the week (`weeklyTimes`). The customer picks the date and one of
 * that day's times when they book.
 *
 * Times are wall-clock "HH:MM" as the agency publishes them, and a departure
 * is stored the way every other time in the system is: as written, with no
 * zone (`2026-11-03T08:30:00.000Z` is "08:30 on 3 November").
 */

export const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/
const DAY_RX = /^\d{4}-\d{2}-\d{2}$/

export interface WeeklyTime {
   /** 0 = Sunday … 6 = Saturday. */
   day: number
   time: string
}

export interface Timetable {
   dailyTimes?: string[]
   weeklyTimes?: WeeklyTime[]
}

/** The day of the week of a YYYY-MM-DD date, as written (no time zone). */
export const weekdayOf = (day: string) => new Date(`${day}T00:00:00.000Z`).getUTCDay()

/** That date's departure times, earliest first, each once. */
export const timesOn = (t: Timetable | undefined, day: string): string[] => {
   const wd = weekdayOf(day)
   const all = [
      ...(t?.dailyTimes ?? []),
      ...(t?.weeklyTimes ?? []).filter((w) => w.day === wd).map((w) => w.time),
   ]
   return [...new Set(all.filter((x) => TIME_RX.test(x)))].sort()
}

/** A route with no time at all cannot be booked. */
export const hasTimetable = (t: Timetable | undefined) =>
   Boolean(t?.dailyTimes?.length || t?.weeklyTimes?.length)

/**
 * The form's lists as they are kept: real times only, each once, in order —
 * a stray blank row or a "8h" must not become a departure nobody can book.
 */
export const cleanTimetable = (raw: any): Timetable => {
   const times = (v: unknown) =>
      [...new Set((Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim()))]
         .filter((x) => TIME_RX.test(x))
         .sort()
   const seen = new Set<string>()
   const weekly = (Array.isArray(raw?.weeklyTimes) ? raw.weeklyTimes : [])
      .map((w: any) => ({ day: Number(w?.day), time: String(w?.time ?? '').trim() }))
      .filter((w: WeeklyTime) => Number.isInteger(w.day) && w.day >= 0 && w.day <= 6 && TIME_RX.test(w.time))
      .filter((w: WeeklyTime) => !seen.has(`${w.day} ${w.time}`) && seen.add(`${w.day} ${w.time}`))
      .sort((a: WeeklyTime, b: WeeklyTime) => a.day - b.day || a.time.localeCompare(b.time))
   return { dailyTimes: times(raw?.dailyTimes), weeklyTimes: weekly }
}

/**
 * The departure the customer asked for, checked against the timetable.
 *
 * `startDate` arrives as "YYYY-MM-DDTHH:MM" (or the same with seconds/Z). It
 * must be one of that day's times, not already gone, and within a year.
 * "Gone" is judged in Kinshasa time (UTC+1), where the office and nearly every
 * departure are.
 *
 * ponytail: one zone for the whole country. Lubumbashi and Goma run an hour
 * later (UTC+2), so a same-day departure there stays bookable for one hour
 * after it has left. Store a zone per location if that ever matters.
 */
export const KINSHASA_OFFSET = '+01:00'
const YEAR_MS = 366 * 86_400_000

export const scheduledDeparture = (
   t: Timetable | undefined,
   startDate: unknown,
   now = Date.now()
): Date | null => {
   const m = String(startDate ?? '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
   if (!m || !DAY_RX.test(m[1])) return null
   const [, day, time] = m
   const local = Date.parse(`${day}T${time}:00${KINSHASA_OFFSET}`)
   if (Number.isNaN(local) || local <= now || local > now + YEAR_MS) return null
   // `Date` rolls 2026-02-31 into March; a date that is not real is refused.
   if (new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) return null
   if (!timesOn(t, day).includes(time)) return null
   return new Date(`${day}T${time}:00.000Z`)
}

// Self-check: `npx ts-node --transpile-only src/services/orders/schedule.service.ts`
if (require.main === module) {
   const assert: typeof import('assert') = require('assert')
   const bus: Timetable = { dailyTimes: ['14:00', '06:30'] }
   const flight: Timetable = { weeklyTimes: [{ day: 1, time: '08:00' }, { day: 3, time: '15:45' }] }
   // 2030-01-07 is a Monday, 2030-01-09 a Wednesday.
   assert.strictEqual(weekdayOf('2030-01-07'), 1)
   assert.deepStrictEqual(timesOn(bus, '2030-01-09'), ['06:30', '14:00'])
   assert.deepStrictEqual(timesOn(flight, '2030-01-07'), ['08:00'])
   assert.deepStrictEqual(timesOn(flight, '2030-01-08'), [])
   assert.ok(hasTimetable(bus) && !hasTimetable({ dailyTimes: [] }))

   const now = Date.parse('2030-01-07T07:30:00+01:00') // Monday 07:30 in Kinshasa
   const at = (s: string) => scheduledDeparture(flight, s, now)?.toISOString()
   assert.strictEqual(at('2030-01-09T15:45'), '2030-01-09T15:45:00.000Z')
   assert.strictEqual(at('2030-01-09T15:46'), undefined) // not on the timetable
   assert.strictEqual(at('2030-01-08T08:00'), undefined) // no flight on Tuesdays
   assert.strictEqual(scheduledDeparture(bus, '2030-01-07T06:30', now), null) // already left
   assert.ok(scheduledDeparture(bus, '2030-01-07T14:00:00.000Z', now)) // later today
   assert.strictEqual(scheduledDeparture(bus, '2032-01-07T14:00', now), null) // over a year out
   assert.strictEqual(scheduledDeparture(bus, '2030-02-31T14:00', now), null) // no such day
   assert.strictEqual(scheduledDeparture(bus, 'banana', now), null)

   assert.deepStrictEqual(
      cleanTimetable({
         dailyTimes: ['14:00', '', '8h', '06:30', '14:00'],
         weeklyTimes: [{ day: 3, time: '09:00' }, { day: 7, time: '09:00' }, { day: 1, time: '09:00' }, { day: 3, time: '09:00' }],
      }),
      { dailyTimes: ['06:30', '14:00'], weeklyTimes: [{ day: 1, time: '09:00' }, { day: 3, time: '09:00' }] }
   )
   console.log('schedule.service: ok')
}
