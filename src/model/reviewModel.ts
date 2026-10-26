import mongoose, { Document, Schema, Types } from 'mongoose'
import { LOCALES } from '../constants/domain.constants'

/**
 * Customer reviews of a listing, a hotel or a restaurant.
 *
 * Written by a signed-in customer, published only once the office approves it.
 * What the catalogue shows as a rating is worked out from the approved ones
 * (`reviewStats` on the item, see reviews.service) — never typed by anyone.
 */

export const REVIEW_TARGETS = ['LISTING', 'HOTEL', 'RESTAURANT'] as const
export type ReviewTarget = (typeof REVIEW_TARGETS)[number]

export const REVIEW_STATUS = {
   PENDING: 'PENDING',
   APPROVED: 'APPROVED',
   REJECTED: 'REJECTED',
} as const
export type ReviewStatus = (typeof REVIEW_STATUS)[keyof typeof REVIEW_STATUS]

export const MAX_REVIEW_COMMENT = 1000

export interface IReview extends Document {
   _id: Types.ObjectId
   targetType: ReviewTarget
   target: Types.ObjectId
   customer: Types.ObjectId
   /** "Patrick M.", as the customer was named when they wrote it. */
   authorName: string
   rating: number
   comment?: string
   locale?: string
   status: ReviewStatus
   /** They had a paid or completed booking of this item when they wrote it. */
   verified: boolean
   moderatedAt?: Date
   moderatedBy?: Types.ObjectId
   createdAt: Date
   updatedAt: Date
}

const reviewSchema = new Schema<IReview>(
   {
      targetType: { type: String, enum: REVIEW_TARGETS, required: true },
      // Not a hard ref: it points into one of three collections.
      target: { type: Schema.Types.ObjectId, required: true },
      customer: { type: Schema.Types.ObjectId, ref: 'PlatformCustomer', required: true },
      authorName: { type: String, required: true, trim: true, maxlength: 80 },
      rating: {
         type: Number,
         required: true,
         min: 1,
         max: 5,
         validate: { validator: Number.isInteger, message: 'The rating is a whole number of stars' },
      },
      comment: { type: String, trim: true, maxlength: MAX_REVIEW_COMMENT },
      locale: { type: String, enum: LOCALES },
      status: {
         type: String,
         enum: Object.values(REVIEW_STATUS),
         default: REVIEW_STATUS.PENDING,
         index: true,
      },
      verified: { type: Boolean, default: false },
      moderatedAt: Date,
      moderatedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
   },
   { timestamps: true }
)

/** One review per customer per item: writing again replaces it. */
reviewSchema.index({ targetType: 1, target: 1, customer: 1 }, { unique: true })

export const Review = mongoose.model<IReview>('Review', reviewSchema)
