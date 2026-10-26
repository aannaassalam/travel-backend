import mongoose, { Document, Schema, Types } from 'mongoose'

/**
 * A driver. Signs in to the driver portal with the phone and a password the
 * office gives them (middleware/driverAuth), drives the one vehicle currently
 * linked to them, and is rated by customers after each completed ride.
 */
export interface IDriver extends Document {
   _id: Types.ObjectId
   name: string
   /** E.164, unique: it is the driver's login. */
   phone: string
   /** A serviced Location name. */
   city: string
   photo?: string
   licenceNumber?: string
   /** The vehicle they drive now. A vehicle may pass between drivers over time. */
   vehicle?: Types.ObjectId
   /**
    * Bcrypt hash, set by the office (hashed with the customer realm's helpers).
    * `select: false` so a driver document never carries it by default.
    */
   password?: string
   /** Sessions opened before this are refused — see driverAuth. */
   passwordChangedAt?: Date
   /** Logout sets this; tokens issued before it are refused. */
   tokensValidFrom?: Date
   isActive: boolean
   /** From the customers' ratings of their completed rides (rideLifecycle). */
   ratingStats: { rating: number; count: number }
   lastSeenAt?: Date
   createdAt: Date
   updatedAt: Date
}

const driverSchema = new Schema<IDriver>(
   {
      name: { type: String, required: true, trim: true, maxlength: 120 },
      phone: {
         type: String,
         required: true,
         trim: true,
         unique: true,
         match: [/^\+[1-9]\d{6,14}$/, 'Phone must be in E.164 format'],
      },
      city: { type: String, required: true, trim: true, index: true },
      photo: { type: String, trim: true, maxlength: 500 },
      licenceNumber: { type: String, trim: true, maxlength: 60 },
      vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle' },
      password: { type: String, select: false },
      passwordChangedAt: Date,
      tokensValidFrom: Date,
      isActive: { type: Boolean, default: true, index: true },
      ratingStats: {
         rating: { type: Number, default: 0 },
         count: { type: Number, default: 0 },
      },
      lastSeenAt: Date,
   },
   { timestamps: true, optimisticConcurrency: true }
)

export const Driver = mongoose.model<IDriver>('Driver', driverSchema)
