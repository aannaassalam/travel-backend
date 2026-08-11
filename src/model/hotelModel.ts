import mongoose, { Document, Schema, Types } from 'mongoose'
import {
   LISTING_STATUS,
   ListingStatus,
   MEAL_PLANS,
} from '../constants/domain.constants'
import {
   baseAmount,
   Localized,
   localizedField,
   Money,
   moneyField,
   resolveLocalized,
} from './shared.schema'

/**
 * Hotels are three levels (§5.2):
 *   Hotel  →  RoomType  →  RatePlan (the inventory lot that actually sells)
 *
 * Nothing here is ever hard deleted (§5.1, §15). Status moves to ARCHIVED so
 * historical orders resolve to their listing forever.
 */

export interface IHotel extends Document {
   _id: Types.ObjectId
   /** Localised — the public site shows the visitor's language, not one for all. */
   name: Localized
   slug: string
   description: Localized
   status: ListingStatus
   stars: number
   address: string
   city: string
   country: string
   geo?: { lat: number; lng: number }
   amenities: string[]
   images: string[]
   /** §5.2: which hotel this stock was bought from (§18 Q9). */
   supplier?: string
   checkInTime: string
   checkOutTime: string
   policies: string
   rating?: number
   reviewCount?: number
   createdBy?: Types.ObjectId
   createdAt: Date
   updatedAt: Date
}

const hotelSchema = new Schema<IHotel>(
   {
      name: localizedField({ required: true }),
      slug: { type: String, required: true, unique: true, lowercase: true },
      description: localizedField(),
      status: {
         type: String,
         enum: Object.values(LISTING_STATUS),
         default: LISTING_STATUS.DRAFT,
         index: true,
      },
      stars: { type: Number, min: 0, max: 5, default: 0 },
      address: { type: String, default: '' },
      // §15: free text where an enum belongs destroys reporting. City stays a
      // string for now because the DRC city list is not yet agreed (§18) — it
      // is trimmed and indexed so it can be migrated to an enum cleanly.
      city: { type: String, required: true, trim: true, index: true },
      country: { type: String, default: 'CD' },
      geo: { lat: Number, lng: Number },
      amenities: { type: [String], default: [] },
      images: { type: [String], default: [] },
      supplier: { type: String, trim: true, index: true },
      checkInTime: { type: String, default: '14:00' },
      checkOutTime: { type: String, default: '11:00' },
      policies: { type: String, default: '' },
      rating: { type: Number, min: 0, max: 5 },
      reviewCount: { type: Number, min: 0, default: 0 },
      createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
   },
   { timestamps: true, optimisticConcurrency: true }
)

/** §5.1 publish validation, enforced server-side rather than only in the form. */
hotelSchema.methods.publishBlockers = function (): string[] {
   const blockers: string[] = []
   if (!this.images?.length) blockers.push('At least one image is required')
   if (!this.name?.fr) blockers.push('French name is required')
   if (!this.description?.fr) blockers.push('French description is required')
   if (!this.city) blockers.push('City is required')
   return blockers
}

/** Convenience for logs, slugs and anywhere a single string is unavoidable. */
hotelSchema.methods.displayName = function (locale?: string) {
   return resolveLocalized(this.name, locale)
}

export const Hotel = mongoose.model<IHotel>('Hotel', hotelSchema)

// ---------------------------------------------------------------------------

export interface IRoomType extends Document {
   _id: Types.ObjectId
   hotel: Types.ObjectId
   name: Localized
   description: Localized
   maxAdults: number
   maxChildren: number
   beds: string
   amenities: string[]
   images: string[]
   sizeSqm?: number
   status: ListingStatus
   createdAt: Date
   updatedAt: Date
}

const roomTypeSchema = new Schema<IRoomType>(
   {
      hotel: {
         type: Schema.Types.ObjectId,
         ref: 'Hotel',
         required: true,
         index: true,
      },
      name: localizedField({ required: true }),
      description: localizedField(),
      maxAdults: { type: Number, default: 2, min: 1 },
      maxChildren: { type: Number, default: 0, min: 0 },
      beds: { type: String, default: '' },
      amenities: { type: [String], default: [] },
      images: { type: [String], default: [] },
      sizeSqm: { type: Number, min: 0 },
      status: {
         type: String,
         enum: Object.values(LISTING_STATUS),
         default: LISTING_STATUS.DRAFT,
      },
   },
   { timestamps: true, optimisticConcurrency: true }
)

export const RoomType = mongoose.model<IRoomType>('RoomType', roomTypeSchema)

// ---------------------------------------------------------------------------

export interface IRatePlan extends Document {
   _id: Types.ObjectId
   hotel: Types.ObjectId
   roomType: Types.ObjectId
   /** One document per room-type per night — the unit the calendar grid edits. */
   date: Date
   /**
    * Per-currency, integer minor units. USD is required — it is the reporting
    * base that margin and spoilage sum in. CDF/EUR are explicit prices the
    * administrator typed, never conversions.
    *
    * costPrice stays mandatory: §15 lists making it optional as the thing that
    * silently destroys margin reporting, because if it is optional it is skipped.
    */
   costPrice: Money
   sellPrice: Money
   allotment: number
   sold: number
   held: number
   mealPlan: string
   blocked: boolean
   createdAt: Date
   updatedAt: Date
}

const ratePlanSchema = new Schema<IRatePlan>(
   {
      hotel: { type: Schema.Types.ObjectId, ref: 'Hotel', required: true },
      roomType: {
         type: Schema.Types.ObjectId,
         ref: 'RoomType',
         required: true,
      },
      date: { type: Date, required: true },
      costPrice: moneyField({ required: true }),
      sellPrice: moneyField({ required: true }),
      allotment: { type: Number, required: true, min: 0, default: 0 },
      sold: { type: Number, default: 0, min: 0 },
      held: { type: Number, default: 0, min: 0 },
      mealPlan: {
         type: String,
         enum: Object.values(MEAL_PLANS),
         default: MEAL_PLANS.ROOM_ONLY,
      },
      blocked: { type: Boolean, default: false },
   },
   { timestamps: true, optimisticConcurrency: true }
)

// One row per room type per night; the calendar upserts against this.
ratePlanSchema.index({ roomType: 1, date: 1 }, { unique: true })
ratePlanSchema.index({ hotel: 1, date: 1 })

/** Units still sellable — allotment minus what is sold or held in checkout. */
ratePlanSchema.virtual('available').get(function (this: IRatePlan) {
   return Math.max(this.allotment - this.sold - this.held, 0)
})

/** Margin in the reporting base. */
ratePlanSchema.virtual('marginBase').get(function (this: IRatePlan) {
   return baseAmount(this.sellPrice) - baseAmount(this.costPrice)
})

ratePlanSchema.set('toObject', { virtuals: true })
ratePlanSchema.set('toJSON', { virtuals: true })

export const RatePlan = mongoose.model<IRatePlan>('RatePlan', ratePlanSchema)
