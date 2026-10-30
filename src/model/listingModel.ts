import mongoose, { Document, Schema, Types } from 'mongoose'
import {
   LISTING_STATUS,
   ListingStatus,
   VERTICALS,
   Vertical,
} from '../constants/domain.constants'
import { CAR_RATES, OPTIONAL_CAR_RATES } from '../services/orders/rental.service'
import { hasTimetable } from '../services/orders/schedule.service'
import {
   baseAmount,
   Localized,
   localizedField,
   Money,
   moneyField,
   videoField,
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

/** Buses and flights are sold as timetabled routes, with no seat count. */
export const isScheduledRoute = (vertical: string) =>
   vertical === VERTICALS.BUS || vertical === VERTICALS.FLIGHT

/** Today in Kinshasa (UTC+1, like KINSHASA_OFFSET), as YYYY-MM-DD. */
const kinshasaDay = (now: number) => new Date(now + 3600_000).toISOString().slice(0, 10)

/** A promotion whose last day is already over in Kinshasa. */
export const promotionEnded = (endsAt: Date | null | undefined, now = Date.now()) =>
   Boolean(endsAt && new Date(endsAt).toISOString().slice(0, 10) < kinshasaDay(now))

/**
 * The discount customers see, in whole percent of the old price (whole
 * francs). The numerator is multiplied first, so 14.5 % is exact and shows 15.
 * The admin's save check uses it too, so no promotion saved shows "−0 %".
 */
export const promotionPercent = (old: number, sell: number) => Math.round(((old - sell) * 100) / old)

/**
 * The promotion customers see, or nothing: an old price above a sell price,
 * through the end of its last day. Display only — the sell price is charged.
 */
export const livePromotion = (
   l: { sellPrice?: Money; promoCompareAtPrice?: Money; promoEndsAt?: Date | null },
   now = Date.now()
) => {
   const old = baseAmount(l.promoCompareAtPrice)
   const sell = baseAmount(l.sellPrice)
   return sell > 0 && old > sell && !promotionEnded(l.promoEndsAt, now)
      ? { old, sell, endsAt: l.promoEndsAt ? new Date(l.promoEndsAt) : undefined }
      : undefined
}

/**
 * Of these rooms or dishes, the one whose running promotion is the biggest
 * discount (the cheaper one on a tie): what a hotel or restaurant card shows.
 */
export const bestPromoted = <T extends Parameters<typeof livePromotion>[0]>(items: T[], now = Date.now()) => {
   let best: { item: T; pct: number; sell: number } | undefined
   for (const item of items) {
      const p = livePromotion(item, now)
      if (!p) continue
      const pct = promotionPercent(p.old, p.sell)
      if (!best || pct > best.pct || (pct === best.pct && p.sell < best.sell)) best = { item, pct, sell: p.sell }
   }
   return best?.item
}

/** The running discount in percent, 0 when none runs: orders promotion pages. */
export const discountOf = (x?: Parameters<typeof livePromotion>[0], now = Date.now()) => {
   const p = x && livePromotion(x, now)
   return p ? promotionPercent(p.old, p.sell) : 0
}

/**
 * A price that can be on promotion on its own: its old price (`promo`) beside
 * its sell price. All of an offer's prices share its one end date,
 * `promoEndsAt`. `label` names it in the office's error messages.
 */
export interface PromoSlot {
   promo: string
   sell: string
   label: string
   /** A route's child or baby fare. */
   fare?: 'CHILD' | 'INFANT'
   /** A car's rate, by its length. */
   hours?: number
}

/** An offer's own price, and a room's or a dish's: the one `promotion` shows. */
export const MAIN_PROMO: PromoSlot = { promo: 'promoCompareAtPrice', sell: 'sellPrice', label: 'offer' }

/** A route's fares; the adult one is its own price. */
const ROUTE_PROMOS: PromoSlot[] = [
   { ...MAIN_PROMO, label: 'adult fare' },
   { promo: 'childPromoCompareAtPrice', sell: 'childSellPrice', label: 'child fare', fare: 'CHILD' },
   { promo: 'infantPromoCompareAtPrice', sell: 'infantSellPrice', label: 'baby fare', fare: 'INFANT' },
]

/** A car's rates (rental.service), shortest first; the 24-hour one is its own price. */
const CAR_PROMOS: PromoSlot[] = CAR_RATES.map((r) => ({
   promo: r.promoField,
   sell: r.sellField,
   label: `${r.hours}-hour rate`,
   hours: r.hours,
}))

/** The prices of this kind of offer that can each be on promotion. */
export const promoSlotsOf = (vertical: string) =>
   vertical === VERTICALS.CAR ? CAR_PROMOS : isScheduledRoute(vertical) ? ROUTE_PROMOS : [MAIN_PROMO]

/** Every slot once: the main price is in both lists. */
const ALL_PROMOS = [...ROUTE_PROMOS, ...CAR_PROMOS.filter((s) => s.promo !== MAIN_PROMO.promo)]

/** What every slot's promotion is read from, for a `select`. */
export const PROMO_FIELDS = [...ALL_PROMOS.flatMap((s) => [s.promo, s.sell]), 'promoEndsAt'].join(' ')

/** One of a listing's prices, as `livePromotion` reads one. */
const slotView = (l: any, s: PromoSlot) => ({
   sellPrice: l?.[s.sell],
   promoCompareAtPrice: l?.[s.promo],
   promoEndsAt: l?.promoEndsAt,
})

/** The promotion customers see on one of a listing's prices, or nothing. */
export const livePromotionOf = (l: any, slot: PromoSlot, now = Date.now()) => livePromotion(slotView(l, slot), now)

/** The biggest running discount on any of a listing's prices, in percent; 0 when none runs. */
export const bestDiscountOf = (l: any, now = Date.now()) =>
   Math.max(0, ...promoSlotsOf(l?.vertical).map((s) => discountOf(slotView(l, s), now)))

/** A slot's old price above its sell price, as a query clause. */
const runningClause = ({ promo, sell }: PromoSlot) => ({
   [`${promo}.CDF`]: { $gt: 0 },
   $expr: { $and: [{ $gt: [`$${sell}.CDF`, 0] }, { $gt: [`$${promo}.CDF`, `$${sell}.CDF`] }] },
})

/** Through its last day in Kinshasa, or with no end date. */
const notEndedClause = (now: number) => ({
   $or: [{ promoEndsAt: null }, { promoEndsAt: { $gte: new Date(`${kinshasaDay(now)}T00:00:00.000Z`) } }],
})

/** `livePromotion` as query clauses, for an `$and`: a room's or a dish's. */
export const livePromotionClauses = (now = Date.now()) => [runningClause(MAIN_PROMO), notEndedClause(now)]

/** A listing with any of its prices on promotion (`livePromotionOf`), as clauses for an `$and`. */
export const listingPromotionClauses = (now = Date.now()) => [
   { $or: ALL_PROMOS.map(runningClause) },
   notEndedClause(now),
]

/** §5.2 per-vertical fields. Validated per vertical in `publishBlockers`. */
const attributesSchema = new Schema(
   {
      // --- Bus and flight routes ---
      /**
       * A bus or flight is one route of one travel agency (the listing's
       * supplier): from `city` to `destination`, on a timetable rather than a
       * date. Buses leave at `dailyTimes` every day; flights at `weeklyTimes`
       * on their days of the week. The customer picks the date and the time.
       * See services/orders/schedule.service.
       */
      destination: { type: String, trim: true },
      dailyTimes: { type: [String], default: undefined },
      weeklyTimes: {
         type: [{ _id: false, day: { type: Number, min: 0, max: 6 }, time: String }],
         default: undefined,
      },
      /** The agency's name, shown as the operator. Kept from the supplier (`syncOperatorName`). */
      operator: String,

      // --- Flights: before routes, an offer was one dated flight. Kept for old records. ---
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
      /**
       * The car type, a code the panel picks: SUV, BERLINE, BUS, PICKUP,
       * MINIBUS, TRUCK, LUXE, MINIVAN, VAN, COUPE, ROADSTER, LIMOUSINE,
       * MICROCAR. No enum: one typed as text before the list existed must not
       * stop the car being saved.
       */
      category: String,
      transmission: { type: String, enum: ['MANUAL', 'AUTOMATIC'] },
      /** Unset when the office has not said: not the same as self-drive. */
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
   /** The optional video: the address its upload answered with (see `videoField`). */
   videoUrl?: string
   /** Who it is bought from; for a bus or flight route, its travel agency. */
   supplier?: Types.ObjectId
   /**
    * Whole francs (USD/EUR are worked out — see moneyField). Cost is
    * required except for Properties, which have no cost of goods. For a bus or
    * flight these are the adult fare (12 and over); for a car, the price for
    * 24 hours.
    */
   costPrice: Money
   sellPrice: Money
   /** Bus and flight fares for a child of 2 to 12, and for a baby under 2. */
   childCostPrice: Money
   childSellPrice: Money
   infantCostPrice: Money
   infantSellPrice: Money
   /**
    * A car's optional prices for 1, 6 and 12 hours, each offered once its sell
    * price is set (see rental.service). Top-level, not in `attributes`: the
    * public listing copies those almost as they are, cost included.
    */
   hourlyCostPrice: Money
   hourlySellPrice: Money
   sixHourCostPrice: Money
   sixHourSellPrice: Money
   twelveHourCostPrice: Money
   twelveHourSellPrice: Money
   /**
    * A promotion, for display only (see `livePromotion`): the price before it,
    * in francs, struck through beside the sell price until the end of
    * `promoEndsAt` (a day, at 00:00 UTC; none = until removed). Customers
    * always pay the sell price: nothing that prices or charges an order reads
    * these. Never `validUntil`, which expires the whole listing.
    */
   promoCompareAtPrice?: Money
   /** The same for a route's child and baby fares and a car's shorter rates: one end date for all (`PromoSlot`). */
   childPromoCompareAtPrice?: Money
   infantPromoCompareAtPrice?: Money
   hourlyPromoCompareAtPrice?: Money
   sixHourPromoCompareAtPrice?: Money
   twelveHourPromoCompareAtPrice?: Money
   promoEndsAt?: Date | null
   quantityTotal: number
   quantitySold: number
   quantityHeld: number
   validFrom?: Date
   validUntil?: Date
   /** The service this departure was repeated from (§5.2 recurrence). */
   repeatOf?: Types.ObjectId
   attributes: any
   rating?: number
   reviewCount?: number
   /** Worked out from approved customer reviews (reviews.service); what the public sees. */
   reviewStats?: { rating: number; count: number }
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
         default: LISTING_STATUS.INACTIVE,
         index: true,
      },
      city: { type: String, required: true, trim: true, index: true },
      country: { type: String, default: 'CD' },
      geo: { lat: Number, lng: Number },
      images: { type: [String], default: [] },
      videoUrl: videoField(),
      supplier: { type: Schema.Types.ObjectId, ref: 'Supplier', index: true },
      costPrice: moneyField(),
      sellPrice: moneyField(),
      childCostPrice: moneyField(),
      childSellPrice: moneyField(),
      infantCostPrice: moneyField(),
      infantSellPrice: moneyField(),
      hourlyCostPrice: moneyField(),
      hourlySellPrice: moneyField(),
      sixHourCostPrice: moneyField(),
      sixHourSellPrice: moneyField(),
      twelveHourCostPrice: moneyField(),
      twelveHourSellPrice: moneyField(),
      promoCompareAtPrice: moneyField(),
      childPromoCompareAtPrice: moneyField(),
      infantPromoCompareAtPrice: moneyField(),
      hourlyPromoCompareAtPrice: moneyField(),
      sixHourPromoCompareAtPrice: moneyField(),
      twelveHourPromoCompareAtPrice: moneyField(),
      promoEndsAt: Date,
      quantityTotal: { type: Number, default: 0, min: 0 },
      quantitySold: { type: Number, default: 0, min: 0 },
      quantityHeld: { type: Number, default: 0, min: 0 },
      validFrom: Date,
      // How "repeat until" knows which days it has already made — not by their
      // address, which two services can share and a renamed city changes.
      repeatOf: { type: Schema.Types.ObjectId, ref: 'Listing', index: true },
      /** Drives §4 at-risk and spoilage for non-hotel stock. */
      validUntil: { type: Date, index: true },
      attributes: { type: attributesSchema, default: {} },
      // Legacy figures from seeds and imports, not from customers: kept, never
      // published or sorted on any more. `reviewStats` replaced them.
      rating: { type: Number, min: 0, max: 5 },
      reviewCount: { type: Number, min: 0, default: 0 },
      // Approved reviews only, rating to one decimal — see reviews.service.
      reviewStats: { rating: Number, count: Number },
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

/**
 * A flight leg is an object or it is not there. A hand-made request can put a
 * null in the list, and every reader of the legs — the publish check, the
 * panel, the ten-minute publishing job — then fails on that one record.
 */
listingSchema.pre('validate', function () {
   const legs = (this.attributes as any)?.segments as unknown[] | undefined
   if (legs?.some((leg) => !leg)) (this.attributes as any).segments = legs.filter(Boolean)
})

/** §5.1 validate-before-publish, plus the per-vertical rules from §5.2. */
listingSchema.methods.publishBlockers = function (): string[] {
   const b: string[] = []
   const isProperty = this.vertical === VERTICALS.PROPERTY
   const isRoute = isScheduledRoute(this.vertical)

   if (!this.title?.fr) b.push('French title is required')
   if (!this.description?.fr) b.push('French description is required')
   if (!this.city) b.push(isRoute ? 'The departure point is required' : 'City is required')

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
         b.push('A cost price is required')
      }
      if (baseAmount(this.sellPrice) <= baseAmount(this.costPrice)) {
         b.push('The sell price must be above the cost price')
      }
      // A route runs every day it is timetabled, with no seat count to keep.
      if (!isRoute && this.quantityTotal <= 0) b.push('Quantity must be above zero')
      // validUntil is no longer managed from the panel, so it must not block:
      // a record that still carries an old date could never be published.
   }

   if (isRoute) {
      const a = this.attributes ?? {}
      if (!this.supplier) b.push('Choose the travel agency (supplier)')
      if (!a.destination) b.push('The destination is required')
      else if (a.destination === this.city) b.push('The destination must differ from the departure point')
      if (!hasTimetable(a)) {
         b.push(
            this.vertical === VERTICALS.FLIGHT
               ? 'Add at least one flight to the weekly timetable'
               : 'Add at least one departure time'
         )
      }
      if (baseAmount(this.childSellPrice) <= 0) b.push('A child fare (2–12 years) is required')
      else if (baseAmount(this.childSellPrice) <= baseAmount(this.childCostPrice)) {
         b.push('The child fare must be above its cost')
      }
      if (baseAmount(this.infantSellPrice) < baseAmount(this.infantCostPrice)) {
         b.push('The baby fare (under 2) cannot be below its cost')
      }
      return b
   }

   // A departure that has already left cannot go back on sale; the nightly job
   // would only expire it again. A flight keeps its time on the first segment.
   const departs = this.attributes?.departsAt ?? this.attributes?.segments?.[0]?.departsAt
   if (departs && new Date(departs).getTime() < Date.now()) {
      b.push('The departure date has passed — set a new date first')
   }
   // The spreadsheet import refuses this row by row; the form has no such
   // check, and the website would print the journey as "-1 h".
   const legs: any[] = (this.attributes?.segments ?? []).filter(Boolean)
   const journeys: any[] = [this.attributes ?? {}, ...legs]
   if (
      journeys.some(
         (j) => j.departsAt && j.arrivesAt && new Date(j.arrivesAt) <= new Date(j.departsAt)
      )
   ) {
      b.push('An arrival time is not after its departure')
   }

   if (this.vertical === VERTICALS.CAR) {
      if (!this.attributes?.make) b.push('Make and model are required')
      // A shorter rate is on sale once it has a price, so it is held to the
      // same rule as the 24-hour one: a cost, and a price above it.
      for (const r of OPTIONAL_CAR_RATES) {
         const sell = baseAmount(this[r.sellField])
         const cost = baseAmount(this[r.costField])
         if (sell <= 0) continue
         if (cost <= 0) b.push(`The ${r.name} price needs a cost`)
         else if (sell <= cost) b.push(`The ${r.name} price must be above its cost`)
      }
   }
   if (this.vertical === VERTICALS.ACTIVITY && !this.attributes?.durationMinutes) {
      b.push('Duration is required')
   }
   return b
}

export const Listing = mongoose.model<IListing>('Listing', listingSchema)
