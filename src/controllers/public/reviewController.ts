import { Request, Response } from 'express'
import { isValidObjectId, Types } from 'mongoose'
import {
   LISTING_STATUS,
   LOCALES,
   ORDER_STATUS,
   PAYMENT_STATUS,
   VERTICALS,
} from '../../constants/domain.constants'
import { presentOwnReview, presentReviews } from '../../dto/public/review.dto'
import { Order } from '../../model/orderModel'
import {
   MAX_REVIEW_COMMENT,
   Review,
   REVIEW_STATUS,
   REVIEW_TARGETS,
   ReviewTarget,
} from '../../model/reviewModel'
import {
   authorNameOf,
   refreshReviewStats,
   REVIEWED,
   reviewStatsOf,
} from '../../services/reviews.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Customer reviews, public side. Anyone reads the approved ones; a signed-in
 * customer writes one per item, which waits for the office before it shows.
 */

const ON_SALE = [LISTING_STATUS.PUBLISHED, LISTING_STATUS.SOLD_OUT]
const MAX_LIMIT = 50

/** The item a request names: a known kind and a well-formed id, or a 400. */
const targetOf = (src: any) => {
   const targetType = String(src?.targetType ?? '') as ReviewTarget
   const target = String(src?.target ?? '')
   if (!REVIEW_TARGETS.includes(targetType)) throw new AppError('Unknown review target type', 400)
   if (!isValidObjectId(target)) throw new AppError('Unknown review target', 400)
   return { targetType, target: new Types.ObjectId(target) }
}

/** GET /reviews?targetType=HOTEL&target=<id>&limit=20 — approved only, newest first. */
export const listReviews = catchAsync(async (req: Request, res: Response) => {
   const { targetType, target } = targetOf(req.query)
   const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 20, 1), MAX_LIMIT)
   const [items, stats] = await Promise.all([
      Review.find({ targetType, target, status: REVIEW_STATUS.APPROVED })
         .sort({ createdAt: -1 })
         .limit(limit),
      reviewStatsOf(targetType, target),
   ])
   sendResponse(res, 200, 'Reviews', {
      items: presentReviews(items),
      total: stats.count,
      // Like the catalogue: no rating at all rather than a 0 out of 5.
      rating: stats.count ? stats.rating : undefined,
      count: stats.count,
   })
})

/** GET /me/reviews?targetType=…&target=… — the signed-in customer's own, whatever its status. */
export const myReview = catchAsync(async (req: Request, res: Response) => {
   const { targetType, target } = targetOf(req.query)
   const review = await Review.findOne({ targetType, target, customer: (req as any).customer._id })
   sendResponse(res, 200, 'OK', { review: presentOwnReview(review) })
})

/**
 * POST /reviews — writes the customer's review of an item, or rewrites it.
 * Either way it goes (back) to PENDING: the office reads what is published.
 */
export const createReview = catchAsync(async (req: Request, res: Response) => {
   // JSON only. The session cookie is SameSite=None in production, so CORS is
   // the CSRF guard — and a form another site posts (urlencoded, no preflight)
   // would still arrive signed in. JSON cannot cross sites without a preflight.
   if (!req.is('application/json')) throw new AppError('Send the review as JSON', 415)
   const customer = (req as any).customer
   const body = req.body ?? {}
   const { targetType, target } = targetOf(body)

   const rating = Number(body.rating)
   if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new AppError('Choose from 1 to 5 stars', 400)
   }
   if (body.comment !== undefined && body.comment !== null && typeof body.comment !== 'string') {
      throw new AppError('The comment must be text', 400)
   }
   const comment = String(body.comment ?? '').trim()
   if (comment.length > MAX_REVIEW_COMMENT) {
      throw new AppError(`A review is limited to ${MAX_REVIEW_COMMENT} characters`, 400)
   }
   const locale = (LOCALES as readonly string[]).includes(body.locale) ? body.locale : undefined

   // Only what the public can book. A property is sold by conversation and
   // has no stay or ride to review.
   const item: any = await (REVIEWED[targetType] as any)
      .findOne({ _id: target, status: { $in: ON_SALE } })
      .select('vertical')
      .lean()
   if (!item) throw new AppError('That item cannot be reviewed', 404)
   if (item.vertical === VERTICALS.PROPERTY) {
      throw new AppError('Properties are sold by enquiry and cannot be reviewed', 400, 'PROPERTY_IS_ENQUIRY_ONLY')
   }

   // "Booked with us": a paid or completed order of theirs has this item on it.
   // A hotel line names the hotel, a dish line its restaurant, as listingId.
   const verified = Boolean(
      await Order.exists({
         customer: customer._id,
         'items.listingId': target,
         $or: [{ paymentStatus: PAYMENT_STATUS.PAID }, { status: ORDER_STATUS.COMPLETED }],
      })
   )

   const key = { targetType, target, customer: customer._id }
   const before = await Review.findOne(key).select('status').lean()
   // An emptied comment or an unknown locale is removed, not left from last time.
   const unset: Record<string, 1> = { moderatedAt: 1, moderatedBy: 1 }
   if (!comment) unset.comment = 1
   if (!locale) unset.locale = 1
   const review = await Review.findOneAndUpdate(
      key,
      {
         $set: {
            authorName: authorNameOf(customer.firstName, customer.lastName),
            rating,
            ...(comment ? { comment } : {}),
            ...(locale ? { locale } : {}),
            verified,
            status: REVIEW_STATUS.PENDING,
         },
         $unset: unset,
         // A new version: an approval of the words the office read before this
         // rewrite is refused (409) instead of publishing these unread.
         $inc: { __v: 1 },
      },
      // One per customer per item (unique index): a second write lands on the first.
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
   )
   // A published review just went back to waiting: it no longer counts.
   if (before?.status === REVIEW_STATUS.APPROVED) await refreshReviewStats(targetType, target)

   sendResponse(res, 201, 'Review received', { review: presentOwnReview(review) })
})
