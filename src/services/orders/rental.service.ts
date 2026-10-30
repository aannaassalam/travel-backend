/**
 * Car hire by the hour.
 *
 * A car is rented from a pick-up time to a return time, and can carry four
 * prices: for one hour, 6 hours, 12 hours and 24 hours. The 24-hour one is the
 * listing's `costPrice`/`sellPrice` — what was its price per day — and the one
 * it needs to publish; the other three are optional. The customer pays the
 * cheapest mix of the offered prices that covers their hours: 30 hours is
 * 24 + 6, and 5 hours is one 6-hour block when that costs less than five
 * single hours.
 *
 * The website and the app show the same sum with the same `planBlocks`
 * (their lib/rental.ts); this is the one that is charged.
 *
 * Times are wall-clock, stored as written with no zone, like every other time
 * here: `2026-11-03T08:00:00.000Z` is "08:00 on 3 November" (see
 * schedule.service).
 */
import { baseAmount } from '../../model/shared.schema'
import { KINSHASA_OFFSET } from './schedule.service'

/**
 * Shortest first. Each rate is offered once its sell price is above zero.
 * `promoField` is its old price while on promotion: display only, never charged.
 */
export const CAR_RATES = [
   {
      hours: 1,
      name: 'hourly',
      costField: 'hourlyCostPrice',
      sellField: 'hourlySellPrice',
      promoField: 'hourlyPromoCompareAtPrice',
   },
   {
      hours: 6,
      name: '6-hour',
      costField: 'sixHourCostPrice',
      sellField: 'sixHourSellPrice',
      promoField: 'sixHourPromoCompareAtPrice',
   },
   {
      hours: 12,
      name: '12-hour',
      costField: 'twelveHourCostPrice',
      sellField: 'twelveHourSellPrice',
      promoField: 'twelveHourPromoCompareAtPrice',
   },
   // The price every car already had, so a car made before hourly rates rents
   // by the 24 hours exactly as it rented by the day.
   {
      hours: 24,
      name: '24-hour',
      costField: 'costPrice',
      sellField: 'sellPrice',
      promoField: 'promoCompareAtPrice',
   },
] as const

/** The three a car may add to its 24-hour price. */
export const OPTIONAL_CAR_RATES = CAR_RATES.filter((r) => r.hours < 24)

export interface CarRate {
   hours: number
   /** Whole francs. */
   sell: number
   cost: number
   sellField: string
   costField: string
}

/** The rates a car is offered at, shortest first. */
export const carRates = (listing: any): CarRate[] =>
   CAR_RATES.map((r) => ({
      hours: r.hours,
      sell: baseAmount(listing?.[r.sellField]),
      cost: baseAmount(listing?.[r.costField]),
      sellField: r.sellField,
      costField: r.costField,
   })).filter((r) => r.sell > 0)

/**
 * The cheapest mix of rates that covers `hours`, going over when that is
 * cheaper. Kept free of imports and identical to the website's and the app's
 * copy, so all three always agree on the sum.
 *
 * rates: offered rates only (base > 0), any order — `base` is the price in the
 * base currency. hours: integer >= 1.
 */
export function planBlocks(
   rates: { hours: number; base: number }[],
   hours: number
): { hours: number; count: number }[] {
   const desc = [...rates].filter((r) => r.base > 0 && r.hours > 0).sort((a, b) => b.hours - a.hours)
   if (!desc.length || !(hours >= 1)) return []
   const best = new Array<number>(hours + 1).fill(Infinity)
   const pick = new Array<number>(hours + 1).fill(-1)
   best[0] = 0
   for (let h = 1; h <= hours; h++) {
      for (let i = 0; i < desc.length; i++) {
         const c = best[Math.max(0, h - desc[i].hours)] + desc[i].base
         if (c < best[h]) { best[h] = c; pick[h] = i } // strict: a tie keeps the longer block
      }
   }
   const counts = new Map<number, number>()
   for (let h = hours; h > 0; ) {
      const r = desc[pick[h]]
      counts.set(r.hours, (counts.get(r.hours) ?? 0) + 1)
      h = Math.max(0, h - r.hours)
   }
   return desc.filter((r) => counts.has(r.hours)).map((r) => ({ hours: r.hours, count: counts.get(r.hours)! }))
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** "YYYY-MM-DD", or with a time "THH:MM" — seconds, milliseconds and a Z allowed, and dropped. */
const RENTAL_RX = /^(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,3})?)?Z?)?$/

/** One end of a rental: the time as written, and the same moment in Kinshasa. */
const rentalEnd = (raw: unknown) => {
   const m = String(raw ?? '').match(RENTAL_RX)
   if (!m) return null
   const [, day, hh = '00', mm = '00'] = m
   const at = new Date(`${day}T${hh}:${mm}:00.000Z`)
   // `Date` rolls 2026-02-31 into March; a date that is not real is refused.
   if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day) return null
   return { at, timed: m[2] !== undefined, kinshasa: Date.parse(`${day}T${hh}:${mm}:00${KINSHASA_OFFSET}`) }
}

export interface Rental {
   start: Date
   end: Date
   /** Started hours count whole: 08:00 to 10:30 is 3. */
   hours: number
   /** Both ends had a time. Older app builds still send days only. */
   timed: boolean
}

/**
 * The pick-up and return the customer asked for. Throws 'INVALID_DATES'
 * (a 400 at checkout) for anything that is not a real, forward rental of a
 * year at most, starting within a year.
 *
 * "Already passed" is judged in Kinshasa time, as for a bus (schedule.service).
 * A time may be up to an hour gone: the customer chose the next full hour and
 * then spent some minutes on the checkout. A day with no time (older app
 * builds) may be today, never yesterday — and the same day twice is no hours.
 */
export const parseRental = (startRaw: unknown, endRaw: unknown, now = Date.now()): Rental => {
   const start = rentalEnd(startRaw)
   const end = rentalEnd(endRaw)
   if (!start || !end) throw new Error('INVALID_DATES')
   const span = end.at.getTime() - start.at.getTime()
   if (span <= 0 || span > 365 * DAY_MS) throw new Error('INVALID_DATES')
   if (start.kinshasa > now + 366 * DAY_MS) throw new Error('INVALID_DATES')
   const gone = start.timed ? start.kinshasa < now - HOUR_MS : start.kinshasa + DAY_MS <= now
   if (gone) throw new Error('INVALID_DATES')
   return { start: start.at, end: end.at, hours: Math.ceil(span / HOUR_MS), timed: start.timed && end.timed }
}

// Self-check: `npx ts-node --transpile-only src/services/orders/rental.service.ts`
if (require.main === module) {
   const assert: typeof import('assert') = require('assert')
   // Francs: $180, $15, $100 and $60 at 2 850 FC, rounded up to the next hundred.
   const all = [
      { hours: 24, base: 513_000 },
      { hours: 1, base: 42_800 },
      { hours: 12, base: 285_000 },
      { hours: 6, base: 171_000 },
   ]
   assert.deepStrictEqual(planBlocks(all, 5), [{ hours: 6, count: 1 }]) // 171 000 FC, not 5 × 42 800 FC
   assert.deepStrictEqual(planBlocks(all, 8), [{ hours: 6, count: 1 }, { hours: 1, count: 2 }])
   assert.deepStrictEqual(planBlocks(all, 30), [{ hours: 24, count: 1 }, { hours: 6, count: 1 }])
   assert.deepStrictEqual(planBlocks(all, 72), [{ hours: 24, count: 3 }])
   // Only the 24-hour price: exactly the old price per day.
   assert.deepStrictEqual(planBlocks([{ hours: 24, base: 513_000 }], 5), [{ hours: 24, count: 1 }])
   assert.deepStrictEqual(planBlocks([{ hours: 24, base: 513_000 }], 49), [{ hours: 24, count: 3 }])
   // A tie keeps the longer block: 12 h at 2 × 6 h's price is one 12-hour block.
   assert.deepStrictEqual(planBlocks([{ hours: 6, base: 50 }, { hours: 12, base: 100 }], 12), [{ hours: 12, count: 1 }])
   assert.deepStrictEqual(planBlocks([{ hours: 24, base: 0 }], 5), [])
   assert.deepStrictEqual(planBlocks(all, 0), [])

   const car = {
      costPrice: { CDF: 342_000 },
      sellPrice: { CDF: 513_000 },
      hourlyCostPrice: { CDF: 14_300 }, // no hourly price: not offered
      hourlySellPrice: { CDF: 0 },
      twelveHourCostPrice: { CDF: 199_500 },
      twelveHourSellPrice: { CDF: 285_000 },
   }
   assert.deepStrictEqual(
      carRates(car).map((r) => [r.hours, r.sell, r.cost]),
      [[12, 285_000, 199_500], [24, 513_000, 342_000]]
   )
   assert.deepStrictEqual(carRates({}), [])
   // A price still in dollars (not yet converted) is not on sale.
   assert.deepStrictEqual(carRates({ sellPrice: { USD: 18000 } }), [])

   const now = Date.parse('2030-01-07T10:30:00+01:00') // Monday 10:30 in Kinshasa
   const rent = (a: string, b: string) => parseRental(a, b, now)
   const refused = (a: string, b: string) => assert.throws(() => rent(a, b), /^Error: INVALID_DATES$/)
   const iso = (r: Rental) => [r.start.toISOString(), r.end.toISOString(), r.hours, r.timed]

   // The same day, by the hour.
   assert.deepStrictEqual(iso(rent('2030-01-07T11:00', '2030-01-07T19:00')), [
      '2030-01-07T11:00:00.000Z', '2030-01-07T19:00:00.000Z', 8, true,
   ])
   assert.deepStrictEqual(iso(rent('2030-01-07T11:00:00.000Z', '2030-01-08T11:00:00Z')).slice(2), [24, true])
   assert.strictEqual(rent('2030-01-07T11:00', '2030-01-07T13:30').hours, 3) // a started hour counts
   refused('2030-01-07T19:00', '2030-01-07T11:00') // reversed
   refused('2030-01-07T11:00', '2030-01-07T11:00') // no time at all
   // Up to an hour gone is still fine; more is not.
   assert.ok(rent('2030-01-07T09:30', '2030-01-07T12:00'))
   refused('2030-01-07T09:00', '2030-01-07T12:00')
   refused('2030-01-06T11:00', '2030-01-07T12:00')

   // Days only (older app builds): today or later, whole days.
   assert.deepStrictEqual(iso(rent('2030-01-07', '2030-01-10')), [
      '2030-01-07T00:00:00.000Z', '2030-01-10T00:00:00.000Z', 72, false,
   ])
   refused('2030-01-07', '2030-01-07') // the same day twice is no hours
   refused('2030-01-06', '2030-01-08') // yesterday
   // Today ends at midnight in Kinshasa, an hour before it does in UTC.
   assert.throws(() => parseRental('2030-01-07', '2030-01-09', Date.parse('2030-01-07T23:30:00Z')), /INVALID_DATES/)
   // One end with a time and one without: priced on the moments, kept as days.
   assert.deepStrictEqual(rent('2030-01-07T11:00', '2030-01-08').timed, false)

   refused('2030-02-31T10:00', '2030-03-03T10:00') // no such day
   refused('2030-02-31', '2030-03-03')
   assert.strictEqual(rent('2030-01-08', '2031-01-08').hours, 8760) // a year is fine
   refused('2030-01-08', '2031-01-09') // 366 days is not
   assert.ok(rent('2031-01-08T10:00', '2031-01-08T11:00')) // starting within a year
   refused('2031-01-09T10:00', '2031-01-09T11:00')
   for (const bad of ['banana', '2030-01-08T24:00', '2030-01-08T10:60', '2030-01-08 10:00', '', '8/1/2030']) {
      refused(bad, '2030-01-09T10:00')
   }
   assert.throws(() => parseRental(undefined, undefined, now), /INVALID_DATES/)
   console.log('rental.service: ok')
}
