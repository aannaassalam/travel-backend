import mongoose, { Document, Schema, Types } from 'mongoose'
import {
   LISTING_STATUS,
   ListingStatus,
   MENU_SECTIONS,
   MenuSection,
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
 * Restaurants are two levels:
 *   Restaurant  →  MenuItem (the thing that actually sells)
 *
 * Deliberately one level shallower than a hotel. A hotel needs RoomType between
 * the property and the sellable lot because the same room sells at a different
 * price on a different night; a dish costs what it costs, so a per-date
 * calendar underneath every item would be a table nobody ever edits.
 *
 * The other difference from the rest of the catalogue: menu items carry no
 * stock count. Seats and rooms are finite and a double-sold one is a real
 * problem; a kitchen either can cook the dish today or it cannot, which is what
 * `isAvailable` says. There is no allotment to hold, so restaurant lines skip
 * the hold path in checkout entirely (see orderController).
 *
 * Nothing here is ever hard deleted (§5.1, §15). Status moves to ARCHIVED so
 * historical orders resolve to their item forever.
 */

/**
 * A delivery zone the restaurant serves, with the fee charged to reach it.
 *
 * Per-currency like every other price (§5): the fee is added to the order total
 * and settled in the same currency as the food, so a fee typed only in USD is
 * what stops an order settling in CDF. Never a conversion.
 */
const deliveryZoneSchema = new Schema(
   {
      name: { type: String, required: true, trim: true },
      fee: moneyField({ required: true }),
      /** Below this the kitchen will not send a driver. Optional. */
      minOrder: moneyField(),
      etaMinutes: { type: Number, min: 0, default: 45 },
      isActive: { type: Boolean, default: true },
   },
   { _id: true }
)

export interface IRestaurant extends Document {
   _id: Types.ObjectId
   name: Localized
   slug: string
   description: Localized
   status: ListingStatus
   cuisines: string[]
   address: string
   city: string
   country: string
   geo?: { lat: number; lng: number }
   images: string[]
   /** Free text per §18 — opening hours vary too much to enum usefully. */
   openingHours: string
   deliveryZones: any
   /** Minutes from order accepted to food ready, before any travel time. */
   prepTimeMinutes: number
   phone?: string
   rating?: number
   reviewCount?: number
   createdBy?: Types.ObjectId
   createdAt: Date
   updatedAt: Date
   /** Declared here, not only attached below, so callers need no cast. */
   publishBlockers(): string[]
   displayName(locale?: string): string
}

const restaurantSchema = new Schema<IRestaurant>(
   {
      name: localizedField({ required: true }),
      slug: { type: String, required: true, unique: true, lowercase: true },
      description: localizedField(),
      status: {
         type: String,
         enum: Object.values(LISTING_STATUS),
         default: LISTING_STATUS.INACTIVE,
         index: true,
      },
      cuisines: { type: [String], default: [] },
      address: { type: String, default: '' },
      // Same reasoning as hotels: string for now, trimmed and indexed so it can
      // migrate to an enum once the DRC city list is agreed (§18).
      city: { type: String, required: true, trim: true, index: true },
      country: { type: String, default: 'CD' },
      geo: { lat: Number, lng: Number },
      images: { type: [String], default: [] },
      openingHours: { type: String, default: '' },
      deliveryZones: { type: [deliveryZoneSchema], default: [] },
      prepTimeMinutes: { type: Number, min: 0, default: 30 },
      phone: { type: String, trim: true },
      rating: { type: Number, min: 0, max: 5 },
      reviewCount: { type: Number, min: 0, default: 0 },
      createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
   },
   { timestamps: true, optimisticConcurrency: true }
)

/**
 * §5.1 publish validation, server-side rather than only in the form.
 *
 * The delivery-zone check is the one that matters most: a published restaurant
 * with no zone takes orders it has no way to price the delivery of, and the
 * failure surfaces at checkout rather than here.
 */
restaurantSchema.methods.publishBlockers = function (): string[] {
   const blockers: string[] = []
   if (!this.images?.length) blockers.push('At least one image is required')
   if (!this.name?.fr) blockers.push('French name is required')
   if (!this.description?.fr) blockers.push('French description is required')
   if (!this.city) blockers.push('City is required')
   if (!this.deliveryZones?.some((z: any) => z.isActive)) {
      blockers.push('At least one active delivery zone is required')
   }
   return blockers
}

restaurantSchema.methods.displayName = function (locale?: string) {
   return resolveLocalized(this.name, locale)
}

export const Restaurant = mongoose.model<IRestaurant>('Restaurant', restaurantSchema)

// ---------------------------------------------------------------------------

export interface IMenuItem extends Document {
   _id: Types.ObjectId
   restaurant: Types.ObjectId
   section: MenuSection
   name: Localized
   description: Localized
   costPrice: Money
   sellPrice: Money
   /** Plural: a dish is worth more than one angle, and the menu row shows the
    *  first while the detail view can show the rest. */
   images: string[]
   /**
    * The "86" toggle. Off means the kitchen has run out today — the item stays
    * on the menu, greyed and unorderable, rather than vanishing and leaving a
    * customer wondering whether they imagined it.
    */
   isAvailable: boolean
   sortOrder: number
   status: ListingStatus
   createdAt: Date
   updatedAt: Date
}

const menuItemSchema = new Schema<IMenuItem>(
   {
      restaurant: {
         type: Schema.Types.ObjectId,
         ref: 'Restaurant',
         required: true,
         index: true,
      },
      section: {
         type: String,
         enum: Object.values(MENU_SECTIONS),
         default: MENU_SECTIONS.MAIN,
         index: true,
      },
      name: localizedField({ required: true }),
      description: localizedField(),
      // Mandatory for the same reason rate plans keep it: §15 names making cost
      // price optional as the thing that silently destroys margin reporting,
      // because once it is optional it is skipped.
      costPrice: moneyField({ required: true }),
      sellPrice: moneyField({ required: true }),
      images: { type: [String], default: [] },
      isAvailable: { type: Boolean, default: true },
      sortOrder: { type: Number, default: 0 },
      status: {
         type: String,
         enum: Object.values(LISTING_STATUS),
         default: LISTING_STATUS.INACTIVE,
         index: true,
      },
   },
   { timestamps: true, optimisticConcurrency: true }
)

// The menu renders section by section, each in the order the office arranged.
menuItemSchema.index({ restaurant: 1, section: 1, sortOrder: 1 })

/** Margin in the reporting base. */
menuItemSchema.virtual('marginBase').get(function (this: IMenuItem) {
   return baseAmount(this.sellPrice) - baseAmount(this.costPrice)
})

menuItemSchema.set('toObject', { virtuals: true })
menuItemSchema.set('toJSON', { virtuals: true })

export const MenuItem = mongoose.model<IMenuItem>('MenuItem', menuItemSchema)
