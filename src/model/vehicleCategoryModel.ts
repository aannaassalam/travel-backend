import mongoose, { Document, Schema, Types } from 'mongoose'
import { Localized, localizedField, Money, moneyField } from './shared.schema'

/**
 * A category of vehicle for transfers — Berline, SUV, Minibus — and its
 * prices. The customer chooses a category, never a vehicle: the office assigns
 * the car and the driver later.
 *
 * Priced per km (a journey A→B) or per hour (a driver at disposal); a category
 * may offer one or both. The cost figures are what the office pays the driver
 * or the owner, for the margin on the booking — never public.
 */
export interface IVehicleCategory extends Document {
   _id: Types.ObjectId
   name: Localized
   description: Localized
   /** The address the panel's upload answered with (folder 'transfers'). */
   image?: string
   /** Passengers it takes. */
   seats: number
   /** "2 grandes valises", free text. */
   luggage?: string
   pricePerKm: Money
   pricePerHour: Money
   /** The least a journey costs, whatever its length. `{}` when unset. */
   minimumFare: Money
   costPerKm: Money
   costPerHour: Money
   sortOrder: number
   isActive: boolean
   createdAt: Date
   updatedAt: Date
}

const vehicleCategorySchema = new Schema<IVehicleCategory>(
   {
      name: localizedField({ required: true }),
      description: localizedField(),
      image: { type: String, trim: true, maxlength: 500 },
      seats: { type: Number, required: true, min: 1, max: 60 },
      luggage: { type: String, trim: true, maxlength: 120 },
      pricePerKm: moneyField(),
      pricePerHour: moneyField(),
      minimumFare: moneyField(),
      costPerKm: moneyField(),
      costPerHour: moneyField(),
      sortOrder: { type: Number, default: 0 },
      isActive: { type: Boolean, default: true, index: true },
   },
   { timestamps: true, optimisticConcurrency: true }
)

export const VehicleCategory = mongoose.model<IVehicleCategory>(
   'VehicleCategory',
   vehicleCategorySchema
)
