import { Types } from 'mongoose'
import { Hotel } from '../model/hotelModel'
import { Listing } from '../model/listingModel'
import { Restaurant } from '../model/restaurantModel'
import { Review, REVIEW_STATUS, ReviewTarget } from '../model/reviewModel'

/** Where each kind of review target lives. */
export const REVIEWED = { LISTING: Listing, HOTEL: Hotel, RESTAURANT: Restaurant } as const

/**
 * How a review is signed: the first name and the surname's initial. The whole
 * surname next to a booking history is more than a stranger reading reviews
 * needs to know about anyone.
 */
export const authorNameOf = (firstName?: string, lastName?: string) => {
   const first = String(firstName ?? '').trim()
   // By code point, so an initial is never half of a character.
   const initial = [...String(lastName ?? '').trim()][0]
   return [first, initial ? `${initial.toUpperCase()}.` : ''].filter(Boolean).join(' ').slice(0, 80)
}

/** The approved reviews of one item: their mean to one decimal, and how many. */
export const reviewStatsOf = async (targetType: ReviewTarget, target: Types.ObjectId | string) => {
   const [row] = await Review.aggregate([
      // aggregate() casts nothing: the id has to arrive as an ObjectId.
      { $match: { targetType, target: new Types.ObjectId(String(target)), status: REVIEW_STATUS.APPROVED } },
      { $group: { _id: null, rating: { $avg: '$rating' }, count: { $sum: 1 } } },
   ])
   return { rating: row ? Math.round(row.rating * 10) / 10 : 0, count: row?.count ?? 0 }
}

/**
 * Writes the item's `reviewStats` again from its approved reviews. Called after
 * every approval, rejection and deletion, and when an approved review is
 * rewritten (it goes back to pending). Recounted rather than incremented, so a
 * missed call is corrected by the next one instead of drifting for good.
 *
 * `updateOne`, and without touching `updatedAt` or the version: a review being
 * approved is not an edit of the hotel, and must not make the office's open
 * form refuse its save as out of date.
 */
export const refreshReviewStats = async (targetType: ReviewTarget, target: Types.ObjectId | string) => {
   const reviewStats = await reviewStatsOf(targetType, target)
   await (REVIEWED[targetType] as any).updateOne(
      { _id: target },
      { $set: { reviewStats } },
      { timestamps: false }
   )
   return reviewStats
}
