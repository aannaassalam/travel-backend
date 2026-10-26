import { baseAmount, Money } from '../../model/shared.schema'

/**
 * The fare of a ride, from its vehicle category's prices. Pure: the only place
 * a transfer price is worked out, used by the quote the customer compares and
 * again at checkout, so the two can never differ.
 *
 * Francs, rounded UP to the next 100 FC — the smallest note anyone hands a
 * driver — so the office is never short on a ride.
 */

export interface FareCategory {
   pricePerKm?: Money | number
   pricePerHour?: Money | number
   minimumFare?: Money | number
   costPerKm?: Money | number
   costPerHour?: Money | number
}

export interface FareRequest {
   mode: 'DISTANCE' | 'HOURLY'
   km?: number
   hours?: number
}

export const MAX_HOURS = 12

/** Up to the next 100 FC; toFixed first so 1 800 × 12.3 does not read as 22 140.000…04 and climb. */
export const roundUp100 = (francs: number) => Math.ceil(Number((francs / 100).toFixed(6))) * 100

/** Whether the category sells this mode at all: a price above zero. */
export const offersMode = (category: FareCategory, mode: FareRequest['mode']) =>
   baseAmount(mode === 'HOURLY' ? category.pricePerHour : category.pricePerKm) > 0

/**
 * `{ price, cost }` in whole francs. Throws a coded Error, as the order pricing
 * does, for a mode the category has no price for or figures that make no sense.
 */
export const quoteFare = (category: FareCategory, { mode, km, hours }: FareRequest) => {
   if (mode === 'HOURLY') {
      const perHour = baseAmount(category.pricePerHour)
      if (perHour <= 0) throw new Error('MODE_NOT_PRICED')
      if (!Number.isInteger(hours) || hours! < 1 || hours! > MAX_HOURS) throw new Error('INVALID_HOURS')
      return {
         price: roundUp100(perHour * hours!),
         cost: roundUp100(baseAmount(category.costPerHour) * hours!),
      }
   }
   if (mode !== 'DISTANCE') throw new Error('INVALID_MODE')
   const perKm = baseAmount(category.pricePerKm)
   if (perKm <= 0) throw new Error('MODE_NOT_PRICED')
   if (!Number.isFinite(km) || km! <= 0) throw new Error('INVALID_DISTANCE')
   return {
      // The minimum applies to what the customer pays, never to the cost.
      price: roundUp100(Math.max(baseAmount(category.minimumFare), perKm * km!)),
      cost: roundUp100(baseAmount(category.costPerKm) * km!),
   }
}

// Self-check: `npx ts-node --transpile-only src/services/transfers/pricing.ts`
if (require.main === module) {
   const assert: typeof import('assert') = require('assert')
   const berline: FareCategory = {
      pricePerKm: { CDF: 1_800 },
      pricePerHour: { CDF: 25_000 },
      minimumFare: { CDF: 15_000 },
      costPerKm: { CDF: 1_100 },
      costPerHour: { CDF: 15_000 },
   }
   assert.strictEqual(roundUp100(22_140), 22_200)
   assert.strictEqual(roundUp100(22_200), 22_200) // already a round hundred stays
   assert.strictEqual(roundUp100(1), 100)
   assert.strictEqual(roundUp100(0), 0)
   assert.strictEqual(roundUp100(1_800 * 12.3), 22_200) // float noise does not add a hundred
   // 12.3 km × 1 800 = 22 140 → 22 200; cost 13 530 → 13 600.
   assert.deepStrictEqual(quoteFare(berline, { mode: 'DISTANCE', km: 12.3 }), { price: 22_200, cost: 13_600 })
   // Under the minimum: the customer pays the minimum, the cost stays real.
   assert.deepStrictEqual(quoteFare(berline, { mode: 'DISTANCE', km: 2 }), { price: 15_000, cost: 2_200 })
   assert.deepStrictEqual(quoteFare(berline, { mode: 'HOURLY', hours: 3 }), { price: 75_000, cost: 45_000 })
   // A category without the mode, and figures that make no sense, are refused.
   const refused = (c: FareCategory, r: FareRequest) => {
      try {
         quoteFare(c, r)
         return null
      } catch (e: any) {
         return e.message
      }
   }
   assert.strictEqual(refused({ pricePerKm: { CDF: 1_800 } }, { mode: 'HOURLY', hours: 2 }), 'MODE_NOT_PRICED')
   assert.strictEqual(refused({ pricePerHour: { CDF: 25_000 } }, { mode: 'DISTANCE', km: 5 }), 'MODE_NOT_PRICED')
   assert.strictEqual(refused(berline, { mode: 'HOURLY', hours: 13 }), 'INVALID_HOURS')
   assert.strictEqual(refused(berline, { mode: 'HOURLY', hours: 1.5 }), 'INVALID_HOURS')
   assert.strictEqual(refused(berline, { mode: 'DISTANCE', km: 0 }), 'INVALID_DISTANCE')
   assert.strictEqual(refused(berline, { mode: 'WEEKLY' as any, km: 1 }), 'INVALID_MODE')
   assert.ok(offersMode(berline, 'HOURLY') && !offersMode({ pricePerKm: { CDF: 1_800 } }, 'HOURLY'))
   // No minimum, no cost: `{}` reads as 0.
   assert.deepStrictEqual(quoteFare({ pricePerKm: { CDF: 1_000 }, minimumFare: {} }, { mode: 'DISTANCE', km: 1 }), { price: 1_000, cost: 0 })
   console.log('transfers/pricing: ok')
}
