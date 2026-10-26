import { Request, Response } from 'express'
import { isValidObjectId } from 'mongoose'

import { Customer } from '../../model/customerModel.admin'
import { Hotel } from '../../model/hotelModel'
import { Listing } from '../../model/listingModel'
import { Restaurant } from '../../model/restaurantModel'
import { IReview, Review, REVIEW_STATUS, REVIEW_TARGETS, ReviewStatus } from '../../model/reviewModel'
import { resolveLocalized } from '../../model/shared.schema'
import { deleteDoc, paginate, updateDoc } from '../../services/adminCrud.service'
import { refreshReviewStats } from '../../services/reviews.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { FieldMap, present } from '../../utils/present'
import { sendResponse } from '../../utils/response'

/**
 * Moderating customer reviews: nothing a customer writes reaches the website
 * until someone here approves it. Each approval, rejection and deletion is in
 * the audit log (updateDoc / deleteDoc), and moves the item's rating with it.
 */

const ENTITY = 'Review'

interface Row {
   review: IReview
   item?: { label: string; vertical: string; slug: string }
   customerName?: string
}

const rowFields: FieldMap<Row> = {
   id: ({ review: r }) => r._id.toString(),
   targetType: ({ review: r }) => r.targetType,
   target: ({ review: r }) => r.target.toString(),
   // Absent when the item has been deleted since.
   targetLabel: ({ item }) => item?.label,
   targetVertical: ({ item }) => item?.vertical,
   targetSlug: ({ item }) => item?.slug,
   customerName: ({ customerName }) => customerName,
   authorName: ({ review: r }) => r.authorName,
   rating: ({ review: r }) => r.rating,
   comment: ({ review: r }) => r.comment,
   locale: ({ review: r }) => r.locale,
   status: ({ review: r }) => r.status,
   verified: ({ review: r }) => Boolean(r.verified),
   moderatedAt: ({ review: r }) => r.moderatedAt,
   createdAt: ({ review: r }) => r.createdAt,
   updatedAt: ({ review: r }) => r.updatedAt,
   // Sent back with approve/reject: a review the customer rewrote since is a 409.
   version: ({ review: r }) => r.__v,
}

/** Each review with the item it is about and the customer who wrote it, read in one go per page. */
const rowsOf = async (reviews: IReview[]) => {
   const of = (type: string) => reviews.filter((r) => r.targetType === type).map((r) => r.target)
   const [listings, hotels, restaurants, customers] = await Promise.all([
      Listing.find({ _id: { $in: of('LISTING') } }).select('title slug vertical').lean(),
      Hotel.find({ _id: { $in: of('HOTEL') } }).select('name slug').lean(),
      Restaurant.find({ _id: { $in: of('RESTAURANT') } }).select('name slug').lean(),
      Customer.find({ _id: { $in: reviews.map((r) => r.customer) } }).select('firstName lastName').lean(),
   ])
   const items = new Map<string, Row['item']>()
   for (const l of listings as any[]) {
      items.set(String(l._id), { label: resolveLocalized(l.title), vertical: l.vertical, slug: l.slug })
   }
   for (const h of hotels as any[]) {
      items.set(String(h._id), { label: resolveLocalized(h.name), vertical: 'HOTEL', slug: h.slug })
   }
   for (const r of restaurants as any[]) {
      items.set(String(r._id), { label: resolveLocalized(r.name), vertical: 'RESTAURANT', slug: r.slug })
   }
   const names = new Map(
      (customers as any[]).map((c) => [String(c._id), [c.firstName, c.lastName].filter(Boolean).join(' ')])
   )
   return reviews.map((review) =>
      present<Row>(
         { review, item: items.get(String(review.target)), customerName: names.get(String(review.customer)) },
         rowFields
      )
   )
}

const escapeRx = (v: string) => v.replace(/\0/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** GET /reviews?status=PENDING&targetType=HOTEL&q=… — newest first, a page at a time. */
export const listReviews = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, any> = {}
   const status = typeof req.query.status === 'string' ? req.query.status : ''
   if (status) {
      if (!(Object.values(REVIEW_STATUS) as string[]).includes(status)) {
         throw new AppError('Unknown review status', 400)
      }
      filter.status = status
   }
   const targetType = typeof req.query.targetType === 'string' ? req.query.targetType : ''
   if (targetType) {
      if (!(REVIEW_TARGETS as readonly string[]).includes(targetType)) {
         throw new AppError('Unknown review target type', 400)
      }
      filter.targetType = targetType
   }
   const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : ''
   if (q) {
      const rx = new RegExp(escapeRx(q), 'i')
      filter.$or = [{ authorName: rx }, { comment: rx }]
   }

   const { items, ...paging } = await paginate<IReview>(Review, filter, req)
   return sendResponse(res, 200, 'OK', { items: await rowsOf(items), ...paging })
})

const moderate = (status: ReviewStatus, message: string) =>
   catchAsync(async (req: Request, res: Response) => {
      if (!isValidObjectId(req.params.id)) throw new AppError('Review not found', 404)
      const review = await updateDoc<IReview>(
         req,
         Review,
         req.params.id,
         { status, moderatedAt: new Date(), moderatedBy: (req as any).admin?._id },
         { entityType: ENTITY }
      )
      await refreshReviewStats(review.targetType, review.target)
      return sendResponse(res, 200, message, { review: (await rowsOf([review]))[0] })
   })

/** POST /reviews/:id/approve — on the website from now on, and in the item's rating. */
export const approveReview = moderate(REVIEW_STATUS.APPROVED, 'Review approved')

/** POST /reviews/:id/reject — kept, never shown; the customer sees it was not published. */
export const rejectReview = moderate(REVIEW_STATUS.REJECTED, 'Review rejected')

/** DELETE /reviews/:id — gone for good; the audit log keeps the text. */
export const deleteReview = catchAsync(async (req: Request, res: Response) => {
   if (!isValidObjectId(req.params.id)) throw new AppError('Review not found', 404)
   const review = await deleteDoc<IReview>(req, Review, { _id: req.params.id }, { entityType: ENTITY })
   await refreshReviewStats(review.targetType, review.target)
   return sendResponse(res, 200, 'Review deleted', {})
})
