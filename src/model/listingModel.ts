import mongoose, { Document, Schema, Types } from 'mongoose'
import {
   LISTING_STATUS,
   ListingStatus,
   VERTICALS,
   Vertical,
} from '../constants/domain.constants'
import {
   baseAmount,
   Localized,
   localizedField,
   Money,
   moneyField,
} from './shared.schema'

/**
 * Flights, Bus, Cars, Activities and Properties (§5.2).
 *
 * ponytail: one collection with a `vertical` discriminator and a typed
 * `attributes` sub-document, rather than five near-identical models. They share
 * every universal pattern in §5.1 — status, clone, archive-never-delete,
 * cost/sell price, publish validation, translation status — so five copies
 * would be five places to fix every one of those. Hotels stay separate because
 * their three-level structure (hotel → room type → nightly lot) genuinely
 * differs; nothing else here does.
 *
 * Split a vertical out if its rules stop fitting `attributes`.
 */

/** §5.2 per-vertical fields. Validated per vertical in `publishBlockers`. */
const attributesSchema = new Schema(
   {
      // --- Flights (modelled as Offers) ---
      tripType: { type: String, enum: ['ONE_WAY', 'RETURN', 'MULTI_CITY'] },
      segments: [
         {
            carrier: String,
            flightNumber: String,
            origin: String, // IATA
            destination: String,
            departsAt: Date,
            arrivesAt: Date,
         },
      ],
      cabin: { type: String, enum: ['ECONOMY', 'PREMIUM', 'BUSINESS', 'FIRST'] },
      baggage: String,
      fareRules: String,
      bookingDeadline: Date,

      // --- Bus ---
      operator: String,
      routeStops: [String],
      vehicleClass: String,
      /** §5.2: without recurrence the same trip gets hand-entered 90 times. */
      recurrence: {
         frequency: { type: String, enum: ['NONE', 'DAILY', 'WEEKLY'] },
         daysOfWeek: [Number],
         until: Date,
      },

      // --- Cars ---
      make: String,
      model: String,
      year: Number,
      category: String,
      transmission: { type: String, enum: ['MANUAL', 'AUTOMATIC'] },
      withDriver: Boolean,
      deposit: Number,
      mileageLimit: String,
      pickupLocations: [String],
      insuranceTerms: String,

      // --- Activities & Tours ---
      durationMinutes: Number,
      advanceNoticeHours: Number,
      blackoutDates: [Date],
      daysOfWeek: [Number],
      minParticipants: Number,
      maxParticipants: Number,
      inclusions: [String],
      exclusions: [String],
      meetingPoint: String,
      languages: [String],
      childPrice: Number,

      // --- Properties (no inventory quantity, no checkout — enquiries only) ---
      propertyType: {
         type: String,
         enum: ['HOUSE_SALE', 'LAND_SALE', 'APARTMENT_RENT', 'HOUSE_RENT', 'LAND_RENT'],
      },
      priceBasis: { type: String, enum: ['TOTAL', 'PER_MONTH'] },
      areaSqm: Number,
      bedrooms: Number,
      bathrooms: Number,
      plotSizeSqm: Number,
      features: [String],
      titleDeedStatus: String,
      availabilityStatus: {
         type: String,
         enum: ['AVAILABLE', 'UNDER_OFFER', 'SOLD', 'RENTED'],
      },

      // Shared
      seatsOrCapacity: Number,
      departsAt: Date,
      arrivesAt: Date,
   },
   { _id: false }
)

export interface IListing extends Document {
   _id: Types.ObjectId
   vertical: Vertical
   /** Localised so the public site renders the visitor's language. */
   title: Localized
   slug: string
   description: Localized
   status: ListingStatus
   city: string
   country: string
   geo?: { lat: number; lng: number }
   images: string[]
   supplier?: string
   /**
    * Per-currency, integer minor units. USD required (reporting base); CDF/EUR
    * are explicit prices, never conversions. Cost is required except for
    * Properties, which have no cost of goods.
    */
   costPrice: Money
   sellPrice: Money
   quantityTotal: number
   quantitySold: number
   quantityHeld: number
   validFrom?: Date
   validUntil?: Date
   attributes: any
   rating?: number
   reviewCount?: number
   publishAt?: Date
   unpublishAt?: Date
   createdBy?: Types.ObjectId
   createdAt: Date
   updatedAt: Date
   publishBlockers(): string[]
}

const listingSchema = new Schema<IListing>(
   {
      vertical: {
         type: String,
         enum: Object.values(VERTICALS),
         required: true,
         index: true,
      },
      title: localizedField({ required: true }),
      slug: { type: String, required: true, unique: true, lowercase: true },
      description: localizedField(),
      status: {
         type: String,
         enum: Object.values(LISTING_STATUS),
         default: LISTING_STATUS.DRAFT,
         index: true,
      },
      city: { type: String, required: true, trim: true, index: true },
      country: { type: String, default: 'CD' },
      geo: { lat: Number, lng: Number },
      images: { type: [String], default: [] },
      supplier: { type: String, trim: true, index: true },
      costPrice: moneyField(),
      sellPrice: moneyField(),
      quantityTotal: { type: Number, default: 0, min: 0 },
      quantitySold: { type: Number, default: 0, min: 0 },
      quantityHeld: { type: Number, default: 0, min: 0 },
      validFrom: Date,
      /** Drives §4 at-risk and spoilage for non-hotel stock. */
      validUntil: { type: Date, index: true },
      attributes: { type: attributesSchema, default: {} },
      // Displayed on the public card. Aggregate only — individual reviews are
      // out of scope for v1 per §18 Q17.
      rating: { type: Number, min: 0, max: 5 },
      reviewCount: { type: Number, min: 0, default: 0 },
      // §5.1 scheduled publish / unpublish.
      publishAt: Date,
      unpublishAt: Date,
      createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
   },
   { timestamps: true, optimisticConcurrency: true }
)

listingSchema.virtual('available').get(function (this: IListing) {
   return Math.max(this.quantityTotal - this.quantitySold - this.quantityHeld, 0)
})
listingSchema.set('toObject', { virtuals: true })
listingSchema.set('toJSON', { virtuals: true })

/** §5.1 validate-before-publish, plus the per-vertical rules from §5.2. */
listingSchema.methods.publishBlockers = function (): string[] {
   const b: string[] = []
   const isProperty = this.vertical === VERTICALS.PROPERTY

   if (!this.title?.fr) b.push('French title is required')
   if (!this.description?.fr) b.push('French description is required')
   if (!this.city) b.push('City is required')

   if (isProperty) {
      // §5.2: properties need a gallery of at least 3 images.
      if ((this.images?.length ?? 0) < 3) {
         b.push('Properties require at least 3 images')
      }
      if (!this.attributes?.propertyType) b.push('Property type is required')
      // Properties have no inventory quantity and no checkout — enquiries only.
   } else {
      if (!this.images?.length) b.push('At least one image is required')
      if (!baseAmount(this.costPrice)) {
         // §15: optional cost price silently destroys margin reporting.
         b.push('A USD cost price is required')
      }
      if (baseAmount(this.sellPrice) <= baseAmount(this.costPrice)) {
         b.push('USD sell price must be above cost price')
      }
      if (this.quantityTotal <= 0) b.push('Quantity must be above zero')
      // validUntil is no longer managed from the panel, so it must not block:
      // a record that still carries an old date could never be published.
   }

   if (this.vertical === VERTICALS.FLIGHT && !this.attributes?.segments?.length) {
      b.push('At least one flight segment is required')
   }
   if (this.vertical === VERTICALS.BUS && !this.attributes?.operator) {
      b.push('Operator is required')
   }
   if (this.vertical === VERTICALS.CAR && !this.attributes?.make) {
      b.push('Make and model are required')
   }
   if (this.vertical === VERTICALS.ACTIVITY && !this.attributes?.durationMinutes) {
      b.push('Duration is required')
   }
   return b
}

export const Listing = mongoose.model<IListing>('Listing', listingSchema)
