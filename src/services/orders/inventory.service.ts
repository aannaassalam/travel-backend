import { Types } from 'mongoose'
import { Listing } from '../../model/listingModel'
import { RatePlan } from '../../model/hotelModel'

/**
 * §4.5 inventory holds.
 *
 * Every mutation here is a single conditional update — the availability test and
 * the increment happen inside one atomic document operation, so two customers
 * racing for the last seat cannot both win. Read-then-write would look correct
 * in testing and oversell under load, which is the failure this file exists to
 * prevent.
 *
 * Three transitions, deliberately explicit:
 *   hold    available -> held      (checkout starts)
 *   commit  held      -> sold      (payment succeeds)
 *   release held      -> available (payment fails, or the hold expires)
 */

/** One night of a hotel stay. Listings use a single pseudo-night. */
export interface HeldNight {
   ratePlanId: Types.ObjectId
}

/**
 * Take `qty` units of a listing. Returns false when there is not enough left,
 * having changed nothing.
 */
export const holdListing = async (listingId: Types.ObjectId, qty: number) => {
   const res = await Listing.updateOne(
      {
         _id: listingId,
         // available = total - sold - held, evaluated server-side in the same
         // operation that increments. `available` is a virtual and cannot be
         // queried, so the arithmetic is spelled out.
         $expr: {
            $gte: [
               {
                  $subtract: [
                     { $subtract: ['$quantityTotal', '$quantitySold'] },
                     '$quantityHeld',
                  ],
               },
               qty,
            ],
         },
      },
      { $inc: { quantityHeld: qty } }
   )
   return res.modifiedCount === 1
}

export const releaseListing = (listingId: Types.ObjectId, qty: number) =>
   Listing.updateOne(
      { _id: listingId, quantityHeld: { $gte: qty } },
      { $inc: { quantityHeld: -qty } }
   )

export const commitListing = (listingId: Types.ObjectId, qty: number) =>
   Listing.updateOne(
      { _id: listingId, quantityHeld: { $gte: qty } },
      { $inc: { quantityHeld: -qty, quantitySold: qty } }
   )

/** Every night in [from, to) — the checkout unit for a hotel stay. */
export const nightsBetween = (from: Date, to: Date): Date[] => {
   const out: Date[] = []
   const d = new Date(from)
   d.setUTCHours(0, 0, 0, 0)
   const end = new Date(to)
   end.setUTCHours(0, 0, 0, 0)
   while (d < end) {
      out.push(new Date(d))
      d.setUTCDate(d.getUTCDate() + 1)
   }
   return out
}

/**
 * Hold `qty` rooms for every night of a stay, or nothing at all.
 *
 * ponytail: each night is its own atomic update and the set is made
 * all-or-nothing by rolling back on the first failure, rather than by a
 * multi-document transaction. A crash between the failure and the rollback
 * leaves the earlier nights held until the expiry sweep releases them — units
 * are never oversold, only briefly unavailable. Upgrade to a session
 * transaction (`withTransaction`) when the deployment is guaranteed to be a
 * replica set; a standalone mongod cannot run one at all.
 */
export const holdStay = async (
   roomTypeId: Types.ObjectId,
   from: Date,
   to: Date,
   qty: number
): Promise<{ ok: boolean; held: Types.ObjectId[] }> => {
   const held: Types.ObjectId[] = []
   for (const date of nightsBetween(from, to)) {
      const plan = await RatePlan.findOneAndUpdate(
         {
            roomType: roomTypeId,
            date,
            blocked: { $ne: true },
            $expr: {
               $gte: [
                  { $subtract: [{ $subtract: ['$allotment', '$sold'] }, '$held'] },
                  qty,
               ],
            },
         },
         { $inc: { held: qty } },
         { new: true }
      )
      if (!plan) {
         for (const id of held) {
            await RatePlan.updateOne({ _id: id, held: { $gte: qty } }, { $inc: { held: -qty } })
         }
         return { ok: false, held: [] }
      }
      held.push(plan._id)
   }
   return { ok: true, held }
}

export const releaseStay = (ids: Types.ObjectId[], qty: number) =>
   RatePlan.updateMany({ _id: { $in: ids }, held: { $gte: qty } }, { $inc: { held: -qty } })

export const commitStay = (ids: Types.ObjectId[], qty: number) =>
   RatePlan.updateMany(
      { _id: { $in: ids }, held: { $gte: qty } },
      { $inc: { held: -qty, sold: qty } }
   )
