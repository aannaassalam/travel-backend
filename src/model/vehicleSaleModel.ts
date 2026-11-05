import mongoose, { Document, Schema, Types } from 'mongoose'
import { LISTING_STATUS, ListingStatus } from '../constants/domain.constants'
import { Localized, localizedField, localizedText, Money, moneyField, videoField } from './shared.schema'

/**
 * Vehicles for sale (2026-11-04): a parking per town holds vehicles the office
 * sells whole, one per order, collected at the parking.
 *
 *   VehicleType, VehicleSpec, VehicleAccessory  the office's lists
 *   Parking  →  SaleVehicle                       what is on sale, where
 *
 * Not the transfers fleet (`vehicles`, `vehiclecategories`): those are driven,
 * these are sold. Nothing here is hard deleted but the office lists, whose
 * delete is refused while a vehicle uses an entry; parkings and vehicles are
 * archived, so an order always resolves to what it sold.
 */

export const VEHICLE_AVAILABILITY = {
   AVAILABLE: 'AVAILABLE',
   /** Held by one order (`reservedOrder`) from checkout until it is cancelled or completed. */
   RESERVED: 'RESERVED',
   SOLD: 'SOLD',
} as const
export type VehicleAvailability = (typeof VEHICLE_AVAILABILITY)[keyof typeof VEHICLE_AVAILABILITY]

export const SPEC_VALUE_TYPES = ['CHOICE', 'NUMBER', 'TEXT'] as const
export type SpecValueType = (typeof SPEC_VALUE_TYPES)[number]

export const VEHICLE_CONDITIONS = ['NEW', 'USED'] as const

const statusField = () => ({
   type: String,
   enum: Object.values(LISTING_STATUS),
   default: LISTING_STATUS.INACTIVE,
   index: true,
})

// ------------------------------------------------------------ office lists

export interface IVehicleType extends Document {
   _id: Types.ObjectId
   name: Localized
   slug: string
   sortOrder: number
   isActive: boolean
}

const vehicleTypeSchema = new Schema<IVehicleType>(
   {
      name: localizedField({ required: true }),
      slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
      sortOrder: { type: Number, default: 0 },
      isActive: { type: Boolean, default: true },
   },
   { timestamps: true, optimisticConcurrency: true }
)

export const VehicleType = mongoose.model<IVehicleType>('VehicleType', vehicleTypeSchema, 'vehicletypes')

export interface ISpecChoice {
   key: string
   label: Localized
}

export interface IVehicleSpec extends Document {
   _id: Types.ObjectId
   name: Localized
   /** Stable: the deep search's `spec.<key>` and the stored values name it. */
   key: string
   valueType: SpecValueType
   /** NUMBER only: "cc", "kg", "ch". */
   unit: string
   /** CHOICE only. A vehicle stores the choice's key. */
   choices: ISpecChoice[]
   /** Offered in the deep search. */
   filterable: boolean
   /** Shown on the result cards. */
   onCard: boolean
   sortOrder: number
   isActive: boolean
}

const vehicleSpecSchema = new Schema<IVehicleSpec>(
   {
      name: localizedField({ required: true }),
      key: { type: String, required: true, unique: true, lowercase: true, trim: true },
      valueType: { type: String, enum: SPEC_VALUE_TYPES, required: true },
      unit: { type: String, default: '', trim: true },
      choices: {
         type: [
            new Schema(
               { key: { type: String, required: true, trim: true }, label: localizedField({ required: true }) },
               { _id: false }
            ),
         ],
         default: [],
      },
      filterable: { type: Boolean, default: true },
      onCard: { type: Boolean, default: false },
      sortOrder: { type: Number, default: 0 },
      isActive: { type: Boolean, default: true },
   },
   { timestamps: true, optimisticConcurrency: true }
)

export const VehicleSpec = mongoose.model<IVehicleSpec>('VehicleSpec', vehicleSpecSchema, 'vehiclespecs')

export interface IVehicleAccessory extends Document {
   _id: Types.ObjectId
   name: Localized
   key: string
   /** "Confort", "Sécurité"…: how the detail page groups the ticks. */
   group: Localized
   sortOrder: number
   isActive: boolean
}

const vehicleAccessorySchema = new Schema<IVehicleAccessory>(
   {
      name: localizedField({ required: true }),
      key: { type: String, required: true, unique: true, lowercase: true, trim: true },
      group: localizedField(),
      sortOrder: { type: Number, default: 0 },
      isActive: { type: Boolean, default: true },
   },
   { timestamps: true, optimisticConcurrency: true }
)

export const VehicleAccessory = mongoose.model<IVehicleAccessory>(
   'VehicleAccessory',
   vehicleAccessorySchema,
   'vehicleaccessories'
)

// ------------------------------------------------------------------ parking

export interface IParking extends Document {
   _id: Types.ObjectId
   name: Localized
   slug: string
   /** A town of the Locations list, as a restaurant's. A vehicle's town is its parking's. */
   city: string
   address: string
   geo?: { lat: number; lng: number }
   phone?: string
   openingHours: Localized
   description: Localized
   images: string[]
   /** The types of vehicles it holds: what the vehicle form offers for it. */
   vehicleTypes: Types.ObjectId[]
   supplier?: Types.ObjectId
   status: ListingStatus
   createdBy?: Types.ObjectId
   createdAt: Date
   updatedAt: Date
   publishBlockers(): string[]
}

const parkingSchema = new Schema<IParking>(
   {
      name: localizedField({ required: true }),
      slug: { type: String, required: true, unique: true, lowercase: true },
      city: { type: String, required: true, trim: true, index: true },
      address: { type: String, default: '', trim: true },
      geo: { lat: Number, lng: Number },
      phone: { type: String, trim: true },
      openingHours: localizedField(),
      description: localizedField(),
      images: { type: [String], default: [] },
      vehicleTypes: { type: [{ type: Schema.Types.ObjectId, ref: 'VehicleType' }], default: [] },
      supplier: { type: Schema.Types.ObjectId, ref: 'Supplier', index: true },
      status: statusField(),
      createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
   },
   { timestamps: true, optimisticConcurrency: true }
)

/** What a customer collecting a vehicle has to be told. */
parkingSchema.methods.publishBlockers = function (): string[] {
   const blockers: string[] = []
   if (!this.name?.fr) blockers.push('French name is required')
   if (!this.city) blockers.push('Town is required')
   if (!this.address) blockers.push('Address is required')
   return blockers
}

export const Parking = mongoose.model<IParking>('Parking', parkingSchema, 'parkings')

// -------------------------------------------------------------- the vehicle

export interface IVehicleSpecValue {
   spec: Types.ObjectId
   choice?: string
   number?: number
   text?: Localized
}

/** Not `extends Document`: a vehicle has a `model`, and so has every mongoose document (as the transfers fleet's). */
export interface ISaleVehicle {
   _id: Types.ObjectId
   parking: Types.ObjectId
   vehicleType: Types.ObjectId
   make: string
   model: string
   year?: number
   mileageKm?: number
   condition: (typeof VEHICLE_CONDITIONS)[number]
   colour?: string
   /** Shown instead of "Make Model Year" when set. */
   title: Localized
   description: Localized
   /** "VS-000123": the reference customers quote, never reused (see nextStockRef). */
   stockRef: string
   /** Office only: never on the public API. */
   vin?: string
   costPrice: Money
   sellPrice: Money
   /** Charged once per booking, whatever the quantity; 0 when it is in the sell price (2026-11-05). */
   processingFee?: Money
   /** A promotion, display only (as a dish): old price + last day. */
   promoCompareAtPrice?: Money
   promoEndsAt?: Date | null
   images: string[]
   videoUrl?: string
   specs: IVehicleSpecValue[]
   accessories: Types.ObjectId[]
   /** The office's: on the website or not. */
   status: ListingStatus
   /** The orders': set by checkout, cancellation and completion only. */
   availability: VehicleAvailability
   reservedOrder?: Types.ObjectId
   soldAt?: Date
   createdBy?: Types.ObjectId
   createdAt: Date
   updatedAt: Date
}

const saleVehicleSchema = new Schema<ISaleVehicle>(
   {
      parking: { type: Schema.Types.ObjectId, ref: 'Parking', required: true, index: true },
      vehicleType: { type: Schema.Types.ObjectId, ref: 'VehicleType', required: true, index: true },
      make: { type: String, required: true, trim: true },
      model: { type: String, required: true, trim: true },
      year: { type: Number, min: 1900, max: 2100 },
      mileageKm: { type: Number, min: 0 },
      condition: { type: String, enum: VEHICLE_CONDITIONS, default: 'USED' },
      colour: { type: String, trim: true },
      title: localizedField(),
      description: localizedField(),
      stockRef: { type: String, required: true, unique: true, uppercase: true, trim: true },
      vin: { type: String, trim: true },
      // Required for the reason a dish's is: margin reporting.
      costPrice: moneyField({ required: true }),
      sellPrice: moneyField({ required: true }),
      processingFee: moneyField(),
      promoCompareAtPrice: moneyField(),
      promoEndsAt: Date,
      images: { type: [String], default: [] },
      videoUrl: videoField(),
      specs: {
         type: [
            new Schema(
               {
                  spec: { type: Schema.Types.ObjectId, ref: 'VehicleSpec', required: true },
                  choice: String,
                  number: Number,
                  text: localizedText(),
               },
               { _id: false }
            ),
         ],
         default: [],
      },
      accessories: { type: [{ type: Schema.Types.ObjectId, ref: 'VehicleAccessory' }], default: [] },
      status: statusField(),
      availability: {
         type: String,
         enum: Object.values(VEHICLE_AVAILABILITY),
         default: VEHICLE_AVAILABILITY.AVAILABLE,
         index: true,
      },
      reservedOrder: { type: Schema.Types.ObjectId, ref: 'Order' },
      soldAt: Date,
      createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
   },
   { timestamps: true, optimisticConcurrency: true }
)

// The search: what is on sale, newest first.
saleVehicleSchema.index({ status: 1, availability: 1, createdAt: -1 })

export const SaleVehicle = mongoose.model<ISaleVehicle>('SaleVehicle', saleVehicleSchema, 'salevehicles')

/**
 * The next stock reference: one above the highest ever given. Vehicles are
 * archived, never deleted, so the highest is never given twice; the unique
 * index settles two saves racing for the same one (the caller retries).
 * ponytail: max+1 would reuse the top number if a vehicle delete is ever added; use a counter document then.
 */
export const nextStockRef = async () => {
   const last = await SaleVehicle.findOne({ stockRef: /^VS-\d{6}$/ }).sort({ stockRef: -1 }).select('stockRef').lean()
   const n = last ? Number(last.stockRef.slice(3)) + 1 : 1
   return `VS-${String(n).padStart(6, '0')}`
}
