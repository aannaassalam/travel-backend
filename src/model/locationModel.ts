import mongoose, { Document, Schema, Types } from 'mongoose'
import { VERTICALS, Vertical } from '../constants/domain.constants'

/**
 * Places the platform actually services.
 *
 * Before this existed, the search box offered a hardcoded list of eight cities
 * baked into the website bundle, while the filter facets were derived from
 * `distinct(city)` over inventory — so the two could disagree, a typo on one
 * listing invented a permanent new city, and adding a real one needed a
 * developer and a deploy. §15 lists exactly that as a thing to avoid.
 *
 * This is the single source of truth: the search box, the destination tiles and
 * the admin's own listing form all read from here.
 */

export const LOCATION_KINDS = {
   CITY: 'CITY',
   AIRPORT: 'AIRPORT',
   STATION: 'STATION',
} as const
export type LocationKind = (typeof LOCATION_KINDS)[keyof typeof LOCATION_KINDS]

export interface ILocation extends Document {
   _id: Types.ObjectId
   name: string
   slug: string
   country: string
   province?: string
   kind: LocationKind
   /** IATA code, for flights. Uppercased on write. */
   iata?: string
   /**
    * Alternative spellings the customer might type — "Kin", "Elisabethville",
    * a French/English variant. Matched on search so a real place is found even
    * when the official name is not what people actually say.
    */
   aliases: string[]
   /** Which products are sold here. A city can be a hotel destination without flights. */
   servesVerticals: Vertical[]
   isActive: boolean
   sortOrder: number
   image?: string
   createdAt: Date
   updatedAt: Date
}

const locationSchema = new Schema<ILocation>(
   {
      name: { type: String, required: true, trim: true },
      slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
      country: { type: String, default: 'CD', uppercase: true, trim: true },
      province: { type: String, trim: true },
      kind: {
         type: String,
         enum: Object.values(LOCATION_KINDS),
         default: LOCATION_KINDS.CITY,
      },
      iata: {
         type: String,
         uppercase: true,
         trim: true,
         match: [/^[A-Z]{3}$/, 'IATA code must be three letters'],
      },
      aliases: { type: [String], default: [] },
      servesVerticals: {
         type: [String],
         enum: Object.values(VERTICALS),
         default: [],
      },
      /**
       * Deactivated rather than deleted. Historical orders and listings name a
       * place; removing the row would orphan them, and a city that stops being
       * serviced this season is usually serviced again next one.
       */
      isActive: { type: Boolean, default: true, index: true },
      /** Manual ordering, so the office can put its busiest cities first. */
      sortOrder: { type: Number, default: 0 },
      image: { type: String, trim: true },
   },
   { timestamps: true }
)

locationSchema.index({ isActive: 1, sortOrder: 1, name: 1 })

export const Location = mongoose.model<ILocation>('Location', locationSchema)

/**
 * Serviced routes, for the two verticals where a pair is the product.
 *
 * A location list alone would imply we fly and drive between every pair of
 * cities we touch, which is how a customer ends up searching a route nobody
 * operates and reading the empty result as "sold out" rather than "we don't go
 * there". Flights and buses are sold as origin→destination, so that is what is
 * modelled.
 */
export interface IRoute extends Document {
   _id: Types.ObjectId
   vertical: Vertical
   origin: Types.ObjectId
   destination: Types.ObjectId
   isActive: boolean
   createdAt: Date
   updatedAt: Date
}

const routeSchema = new Schema<IRoute>(
   {
      vertical: {
         type: String,
         enum: [VERTICALS.FLIGHT, VERTICALS.BUS],
         required: true,
         index: true,
      },
      origin: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
      destination: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
      isActive: { type: Boolean, default: true, index: true },
   },
   { timestamps: true }
)

/** One row per direction: Kinshasa→Goma being sold does not imply the return. */
routeSchema.index({ vertical: 1, origin: 1, destination: 1 }, { unique: true })

export const ServicedRoute = mongoose.model<IRoute>('ServicedRoute', routeSchema)
