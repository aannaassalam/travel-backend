import mongoose, { Schema, Types } from 'mongoose'

/**
 * One car of the fleet, in one city. The customer never picks it: the office
 * assigns a driver, and the driver's current vehicle comes with them.
 *
 * Not `extends Document`: a car has a `model`, and so does every mongoose
 * document (the method) — callers get a HydratedDocument<IVehicle> instead.
 */
export interface IVehicle {
   _id: Types.ObjectId
   /** A serviced Location name, as listings name their city. */
   city: string
   category: Types.ObjectId
   make: string
   model: string
   year?: number
   color?: string
   /** Uppercased; one plate per city. */
   plate: string
   /** Overrides the category's seat count when set. */
   seats?: number
   image?: string
   isActive: boolean
   createdAt: Date
   updatedAt: Date
}

const vehicleSchema = new Schema<IVehicle>(
   {
      city: { type: String, required: true, trim: true, index: true },
      category: { type: Schema.Types.ObjectId, ref: 'VehicleCategory', required: true, index: true },
      make: { type: String, required: true, trim: true, maxlength: 60 },
      model: { type: String, required: true, trim: true, maxlength: 60 },
      year: { type: Number, min: 1950, max: 2100 },
      color: { type: String, trim: true, maxlength: 40 },
      plate: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
      seats: { type: Number, min: 1, max: 60 },
      image: { type: String, trim: true, maxlength: 500 },
      isActive: { type: Boolean, default: true },
   },
   { timestamps: true, optimisticConcurrency: true }
)

/** The same plate twice in one city is the same car typed twice. */
vehicleSchema.index({ city: 1, plate: 1 }, { unique: true })

export const Vehicle = mongoose.model<IVehicle>('Vehicle', vehicleSchema)
