/**
 * Make the dev catalogue bookable again WITHOUT reseeding.
 *
 *   npm run qa:inventory                      # dry run — reports, writes nothing
 *   npm run qa:inventory -- --apply           # write
 *   npm run qa:inventory -- --apply --min=8 --days=90
 *   npm run qa:inventory -- --self-test       # pure-math checks, no database
 *
 * Three additive steps, in order:
 *
 *   1. Release ORPHANED holds. `quantityHeld` / `held` is reset to the units
 *      that live, unpaid orders (DRAFT/SUBMITTED × UNPAID/PENDING/FAILED — the
 *      same filter the 10-minute cron uses) actually hold. A hold with no order
 *      behind it can never be released by the cron (it keys off `cashDeadline`
 *      on an order) and is never flagged by the drift job (it checks sold >
 *      total only), so it silently removes the unit from sale for ever. One
 *      known producer: createOrder's ACCOUNT_EXISTS `return next(...)` sits
 *      inside the try that owns the rollback, so that path keeps its hold.
 *
 *   2. Top up PUBLISHED, sellable listings (not PROPERTY) so each has at least
 *      `--min` units available: quantityTotal = sold + held + min. SOLD_OUT and
 *      EXPIRED rows are left alone — the seed makes some deliberately so the
 *      empty state stays reachable.
 *
 *   3. Hotels: for every PUBLISHED room type of a PUBLISHED hotel, each night in
 *      [today, today + --days) has a rate plan with at least `--min` available.
 *      Existing cells get their allotment raised; missing nights are created by
 *      copying the room's most recent cell (price, meal plan). Blocked nights
 *      are respected. A room with no cell at all is reported and skipped — this
 *      script does not invent prices.
 *
 * Nothing is deleted, no status changes, hotels/listings/orders keep their ids.
 * Same guard as seed:catalogue: a non-local database needs SEED_CONFIRM=1, and
 * NODE_ENV=production is refused outright.
 */
import assert from 'assert'
import dotenv from 'dotenv'
import mongoose, { Types } from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import {
   LISTING_STATUS,
   ORDER_STATUS,
   PAYMENT_STATUS,
   VERTICALS,
} from '../constants/domain.constants'
import { Hotel, RatePlan, RoomType } from '../model/hotelModel'
import { Listing } from '../model/listingModel'
import { Order } from '../model/orderModel'

/* ------------------------------------------------------------------- flags */

const flag = (name: string) => process.argv.includes(`--${name}`)
const num = (name: string, dflt: number) => {
   const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
   const v = hit ? Number(hit.split('=')[1]) : NaN
   return Number.isInteger(v) && v > 0 ? v : dflt
}
const APPLY = flag('apply')
const MIN = num('min', 5)
const DAYS = num('days', 60)

/* --------------------------------------------------------------- pure math */

/** New quantityTotal, or null when the row already has enough. */
export const topUp = (total: number, sold: number, held: number, min: number) =>
   total - sold - held >= min ? null : sold + held + min

/**
 * Units each listing / rate plan should currently hold, from the orders that
 * are still waiting on payment. Mirrors releaseExpiredCashHolds: a hotel item's
 * quantity is applied to every id in `heldRatePlanIds`.
 */
export const liveHolds = (orders: any[]) => {
   const listings = new Map<string, number>()
   const plans = new Map<string, number>()
   const add = (m: Map<string, number>, k: string, q: number) => m.set(k, (m.get(k) ?? 0) + q)
   for (const o of orders) {
      for (const item of o.items ?? []) {
         const qty = Number(item.quantity) || 0
         if (item.roomTypeId) {
            for (const id of o.heldRatePlanIds ?? []) add(plans, String(id), qty)
         } else if (item.listingId && item.vertical !== VERTICALS.RESTAURANT) {
            add(listings, String(item.listingId), qty)
         }
      }
   }
   return { listings, plans }
}

const utcDay = (offset: number) => {
   const d = new Date()
   d.setUTCHours(0, 0, 0, 0)
   d.setUTCDate(d.getUTCDate() + offset)
   return d
}

if (flag('self-test')) {
   assert.strictEqual(topUp(6, 5, 1, 5), 11, 'tops up to sold+held+min')
   assert.strictEqual(topUp(10, 2, 0, 5), null, 'leaves a row that has enough')
   assert.strictEqual(topUp(5, 0, 0, 5), null, 'exactly min is enough')
   const h = liveHolds([
      { items: [{ listingId: 'L1', quantity: 2 }, { listingId: 'L1', quantity: 1 }] },
      { items: [{ roomTypeId: 'R', quantity: 3 }], heldRatePlanIds: ['P1', 'P2'] },
      { items: [{ listingId: 'D', vertical: VERTICALS.RESTAURANT, quantity: 9 }] },
   ])
   assert.deepStrictEqual([...h.listings], [['L1', 3]], 'sums per listing, skips dishes')
   assert.deepStrictEqual([...h.plans], [['P1', 3], ['P2', 3]], 'applies qty to every held night')
   console.log('addQaInventory self-test passed')
   process.exit(0)
}

/* -------------------------------------------------------------------- main */

const run = async () => {
   if (process.env.NODE_ENV === 'production') {
      throw new Error('qa:inventory refuses to run with NODE_ENV=production')
   }
   const uri = buildMongoUri()
   if (!/(localhost|127\.0\.0\.1)/.test(uri) && process.env.SEED_CONFIRM !== '1') {
      throw new Error(
         'Refusing to touch a non-local database. Set SEED_CONFIRM=1 if this really is the dev cluster.'
      )
   }
   await mongoose.connect(uri)
   console.log(`connected: ${mongoose.connection.name}  mode: ${APPLY ? 'APPLY' : 'DRY RUN'}  min=${MIN} days=${DAYS}\n`)

   // --- 1. orphaned holds ---------------------------------------------------
   const live = liveHolds(
      await Order.find({
         status: { $in: [ORDER_STATUS.DRAFT, ORDER_STATUS.SUBMITTED] },
         paymentStatus: {
            $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING, PAYMENT_STATUS.FAILED],
         },
      }).lean()
   )

   const listingOps: any[] = []
   for (const l of await Listing.find({ quantityHeld: { $gt: 0 } }).lean()) {
      const want = live.listings.get(String(l._id)) ?? 0
      if (l.quantityHeld === want) continue
      console.log(`  release  ${l.vertical.padEnd(8)} ${l.slug}: held ${l.quantityHeld} -> ${want}`)
      listingOps.push({ updateOne: { filter: { _id: l._id, quantityHeld: l.quantityHeld }, update: { $set: { quantityHeld: want } } } })
      l.quantityHeld = want // so step 2 sees the corrected figure
   }
   const planOps: any[] = []
   for (const p of await RatePlan.find({ held: { $gt: 0 } }).lean()) {
      const want = live.plans.get(String(p._id)) ?? 0
      if (p.held === want) continue
      console.log(`  release  night ${p.date.toISOString().slice(0, 10)} room ${p.roomType}: held ${p.held} -> ${want}`)
      planOps.push({ updateOne: { filter: { _id: p._id, held: p.held }, update: { $set: { held: want } } } })
   }
   console.log(`holds: ${listingOps.length} listing(s), ${planOps.length} night(s) orphaned\n`)

   // --- 2. listings -----------------------------------------------------------
   const sellable = await Listing.find({
      status: LISTING_STATUS.PUBLISHED,
      vertical: { $ne: VERTICALS.PROPERTY },
   }).lean()
   for (const l of sellable) {
      const held = listingOps.find((o) => String(o.updateOne.filter._id) === String(l._id))
         ? (live.listings.get(String(l._id)) ?? 0)
         : l.quantityHeld
      const total = topUp(l.quantityTotal, l.quantitySold, held, MIN)
      if (total === null) continue
      console.log(`  top-up   ${l.vertical.padEnd(8)} ${l.slug}: total ${l.quantityTotal} -> ${total} (sold ${l.quantitySold}, held ${held})`)
      listingOps.push({ updateOne: { filter: { _id: l._id }, update: { $set: { quantityTotal: total } } } })
   }
   console.log(`listings: ${sellable.length} published sellable, ${listingOps.length} write(s) queued\n`)

   // --- 3. hotel nights -------------------------------------------------------
   const hotelIds = (await Hotel.find({ status: LISTING_STATUS.PUBLISHED }).select('_id').lean()).map((h) => h._id)
   const rooms = await RoomType.find({ hotel: { $in: hotelIds }, status: LISTING_STATUS.PUBLISHED }).lean()
   const from = utcDay(0)
   const to = utcDay(DAYS)
   let raised = 0
   let created = 0
   const noTemplate: string[] = []
   for (const room of rooms) {
      const cells = await RatePlan.find({ roomType: room._id, date: { $gte: from, $lt: to } }).lean()
      const byDay = new Map(cells.map((c) => [c.date.toISOString().slice(0, 10), c]))
      const template = await RatePlan.findOne({ roomType: room._id }).sort({ date: -1 }).lean()
      if (!template) {
         noTemplate.push(`${room.hotel}/${room._id}`)
         continue
      }
      for (let n = 0; n < DAYS; n++) {
         const date = utcDay(n)
         const key = date.toISOString().slice(0, 10)
         const cell = byDay.get(key)
         if (cell) {
            if (cell.blocked) continue
            const held = planOps.find((o) => String(o.updateOne.filter._id) === String(cell._id))
               ? (live.plans.get(String(cell._id)) ?? 0)
               : cell.held
            const allotment = topUp(cell.allotment, cell.sold, held, MIN)
            if (allotment === null) continue
            raised++
            planOps.push({ updateOne: { filter: { _id: cell._id }, update: { $set: { allotment } } } })
         } else {
            created++
            planOps.push({
               insertOne: {
                  document: {
                     hotel: room.hotel,
                     roomType: room._id,
                     date,
                     costPrice: template.costPrice,
                     sellPrice: template.sellPrice,
                     mealPlan: template.mealPlan,
                     allotment: MIN,
                     sold: 0,
                     held: 0,
                     blocked: false,
                  },
               },
            })
         }
      }
   }
   console.log(`hotels: ${rooms.length} published room(s); ${raised} night(s) raised, ${created} night(s) created`)
   if (noTemplate.length) console.log(`  skipped (no rate plan to copy): ${noTemplate.join(', ')}`)

   // --- write -----------------------------------------------------------------
   if (!APPLY) {
      console.log(`\nDRY RUN — ${listingOps.length + planOps.length} write(s) planned. Re-run with --apply.`)
   } else {
      const a = listingOps.length ? await Listing.bulkWrite(listingOps, { ordered: false }) : null
      const b = planOps.length ? await RatePlan.bulkWrite(planOps, { ordered: false }) : null
      console.log(
         `\nAPPLIED — listings modified ${a?.modifiedCount ?? 0}; nights modified ${b?.modifiedCount ?? 0}, inserted ${b?.insertedCount ?? 0}`
      )
   }
   await mongoose.disconnect()
}

run().catch((err) => {
   console.error(err.message)
   process.exit(1)
})
