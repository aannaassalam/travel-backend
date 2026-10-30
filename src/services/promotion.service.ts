import { MAIN_PROMO, PromoSlot, promotionEnded, promotionPercent } from '../model/listingModel'
import { baseAmount, parseMoney } from '../model/shared.schema'
import AppError from '../utils/appError'
import { writtenDay } from '../utils/dayRange'

/**
 * A promotion, as sent: an old price in francs for each price it may cover
 * (`slots`: a listing's are `promoSlotsOf` its vertical; a room's or a dish's,
 * its one price) — blank takes that price off promotion — and its last day,
 * 'YYYY-MM-DD' or null, which goes once no old price is left. Display only:
 * customers pay the sell price. Checked when a save changes the promotion or
 * a price it covers, so an edit elsewhere never trips over one that has ended.
 * `patch` already holds the prices the save sets. Shared by listings, room
 * types and dishes.
 */
export const applyPromotion = (
   body: any,
   patch: Record<string, any>,
   current?: Record<string, any> | null,
   slots: PromoSlot[] = [MAIN_PROMO]
) => {
   for (const { promo } of slots) {
      if (body[promo] === undefined) continue
      // 0, not `{}`: an empty object is dropped on save and the old price kept.
      const typed = parseMoney(body[promo])
      patch[promo] = typed?.CDF !== undefined ? typed : { CDF: 0 }
   }
   if (body.promoEndsAt !== undefined) {
      const day = writtenDay(body.promoEndsAt)
      if (!day && body.promoEndsAt !== null && body.promoEndsAt !== '') {
         throw new AppError('The promotion end date must be a date (YYYY-MM-DD)', 400)
      }
      patch.promoEndsAt = day
   }
   // A price as the save leaves it: one sent blank (`{}`) keeps the one stored.
   const saved = (field: string) => baseAmount(patch[field]?.CDF !== undefined ? patch[field] : current?.[field])
   const before = (field: string) => baseAmount(current?.[field])
   const on: PromoSlot[] = []
   for (const slot of slots) {
      if (!saved(slot.promo)) continue
      if (saved(slot.sell) > 0) on.push(slot)
      // A price not on offer (a car rate left blank, a free baby fare) has nothing to take off.
      else if (body[slot.promo] !== undefined) {
         throw new AppError(`The ${slot.label} has no price, so it cannot be on promotion`, 400)
      }
      // Its price was just taken away: its old price goes with it.
      else patch[slot.promo] = { CDF: 0 }
   }
   if (!on.length) {
      if (body.promoEndsAt !== undefined || slots.some((s) => patch[s.promo] !== undefined)) {
         patch.promoEndsAt = null
      }
      return
   }
   const ends = patch.promoEndsAt !== undefined ? patch.promoEndsAt : current?.promoEndsAt
   const dayOf = (d?: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null)
   const dayChanged = !current || dayOf(ends) !== dayOf(current.promoEndsAt)
   const ended = promotionEnded(ends)
   // Only a new old price or end day: one taken off never asks for a new date.
   if (ended && (dayChanged || on.some((s) => saved(s.promo) !== before(s.promo)))) {
      throw new AppError('The promotion end date is in the past: choose today or a later day', 400)
   }
   if (ended) return
   for (const s of on) {
      const [old, sell] = [saved(s.promo), saved(s.sell)]
      // As customers see it, rounded: a promotion that would read "−0 %" is refused.
      if ((dayChanged || old !== before(s.promo) || sell !== before(s.sell)) && promotionPercent(old, sell) < 1) {
         throw new AppError(
            s.promo === MAIN_PROMO.promo
               ? 'The old price (before the promotion) must be higher than the sell price, in FC, for a discount of at least 1%'
               : `The old price of the ${s.label} must be higher than its price, in FC, for a discount of at least 1%`,
            400
         )
      }
   }
}

/** Whether a save touches what a promotion is checked against. */
export const touchesPromotion = (body: any) =>
   body.promoCompareAtPrice !== undefined || body.promoEndsAt !== undefined || body.sellPrice !== undefined
