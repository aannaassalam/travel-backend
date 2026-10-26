import mongoose, { Document, Schema, Types } from 'mongoose'
import { Money, moneyField } from './shared.schema'

/**
 * A ride ("course"): one transfer with a driver, sold as one ordinary Order
 * (vertical TRANSFER, one line whose listingId is this ride). The order carries
 * checkout, payment and the cash deadline; the ride carries what is specific —
 * the two points, the route, the driver, the status timeline, the rating and
 * the security alerts.
 *
 * `at` is a wall-clock time stored like every other time in the system: as
 * written, with no zone (see orders/schedule.service).
 */
export const RIDE_STATUS = {
   PENDING: 'PENDING',
   ASSIGNED: 'ASSIGNED',
   STARTED: 'STARTED',
   COMPLETED: 'COMPLETED',
   CANCELLED: 'CANCELLED',
} as const
export type RideStatus = (typeof RIDE_STATUS)[keyof typeof RIDE_STATUS]

export const RIDE_MODES = { DISTANCE: 'DISTANCE', HOURLY: 'HOURLY' } as const
export type RideMode = (typeof RIDE_MODES)[keyof typeof RIDE_MODES]

export const RIDE_ACTORS = ['CUSTOMER', 'DRIVER', 'OFFICE', 'SYSTEM'] as const
export type RideActor = (typeof RIDE_ACTORS)[number]

export interface RidePoint {
   label: string
   lat: number
   lng: number
   /** One of the office's saved places, when the customer picked one. */
   placeId?: Types.ObjectId
}

export interface IRide extends Document {
   _id: Types.ObjectId
   order?: Types.ObjectId
   /** The order's reference, once the order exists. What the driver portal keys on. */
   reference?: string
   status: RideStatus
   mode: RideMode
   city: string
   pickup: RidePoint
   /** Absent on a ride by the hour with no destination given. */
   dropoff?: RidePoint
   at: Date
   /** By the hour: 1–12. */
   hours?: number
   passengers: number
   category: Types.ObjectId
   /** The category's French name when booked — the category may be renamed later. */
   categoryName: string
   distanceKm: number
   durationMinutes: number
   routeSource: 'ROUTING' | 'ESTIMATE'
   /** `[lng, lat]` points to draw, at most 500. */
   route?: number[][]
   /** Whole francs, as quoted when booked. */
   price: Money
   cost: Money
   customer: Types.ObjectId
   customerName: string
   customerPhone: string
   driver?: Types.ObjectId
   vehicle?: Types.ObjectId
   assignedAt?: Date
   startedAt?: Date
   endedAt?: Date
   cancelledAt?: Date
   cancellationReason?: string
   /** The customer's note: flight number, luggage, a child seat. */
   notes?: string
   timeline: { at: Date; event: string; actor: RideActor; detail?: string }[]
   rating?: { score: number; comment?: string; at: Date }
   alerts: { at: Date; by: 'CUSTOMER' | 'DRIVER'; lat?: number; lng?: number; note?: string; smsSent: boolean }[]
   createdAt: Date
   updatedAt: Date
}

const pointSchema = new Schema<RidePoint>(
   {
      label: { type: String, required: true, trim: true, maxlength: 200 },
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      placeId: { type: Schema.Types.ObjectId, ref: 'TransferPlace' },
   },
   { _id: false }
)

const rideSchema = new Schema<IRide>(
   {
      order: { type: Schema.Types.ObjectId, ref: 'Order', index: true },
      reference: { type: String, index: true, sparse: true },
      status: { type: String, enum: Object.values(RIDE_STATUS), default: RIDE_STATUS.PENDING },
      mode: { type: String, enum: Object.values(RIDE_MODES), required: true },
      city: { type: String, required: true, trim: true, index: true },
      pickup: { type: pointSchema, required: true },
      dropoff: { type: pointSchema },
      at: { type: Date, required: true },
      hours: { type: Number, min: 1, max: 12 },
      passengers: { type: Number, required: true, min: 1, max: 60 },
      category: { type: Schema.Types.ObjectId, ref: 'VehicleCategory', required: true },
      categoryName: { type: String, required: true },
      distanceKm: { type: Number, default: 0 },
      durationMinutes: { type: Number, default: 0 },
      routeSource: { type: String, enum: ['ROUTING', 'ESTIMATE'], default: 'ESTIMATE' },
      route: { type: [[Number]], default: undefined },
      price: moneyField({ required: true }),
      cost: moneyField(),
      customer: { type: Schema.Types.ObjectId, ref: 'PlatformCustomer', required: true },
      customerName: { type: String, default: '' },
      customerPhone: { type: String, default: '' },
      driver: { type: Schema.Types.ObjectId, ref: 'Driver' },
      vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle' },
      assignedAt: Date,
      startedAt: Date,
      endedAt: Date,
      cancelledAt: Date,
      cancellationReason: String,
      notes: { type: String, trim: true, maxlength: 300 },
      timeline: {
         type: [
            {
               _id: false,
               at: { type: Date, default: Date.now },
               event: { type: String, required: true },
               actor: { type: String, enum: RIDE_ACTORS, required: true },
               detail: String,
            },
         ],
         default: [],
      },
      rating: {
         type: new Schema(
            {
               score: { type: Number, min: 1, max: 5, required: true },
               comment: { type: String, trim: true, maxlength: 500 },
               at: { type: Date, default: Date.now },
            },
            { _id: false }
         ),
         default: undefined,
      },
      alerts: {
         type: [
            {
               _id: false,
               at: { type: Date, default: Date.now },
               by: { type: String, enum: ['CUSTOMER', 'DRIVER'], required: true },
               lat: Number,
               lng: Number,
               note: { type: String, trim: true, maxlength: 300 },
               smsSent: { type: Boolean, default: false },
            },
         ],
         default: [],
      },
   },
   { timestamps: true }
)

rideSchema.index({ status: 1, at: 1 })
rideSchema.index({ driver: 1, at: 1 })
rideSchema.index({ customer: 1 })

export const Ride = mongoose.model<IRide>('Ride', rideSchema)

/** How long after the ride ends a security alert can still be raised. */
export const ALERT_AFTER_COMPLETED_MS = 2 * 60 * 60_000

/**
 * Whether an alert can be raised: from the moment a driver is assigned until
 * two hours after the ride. Pure, and on the model so the DTOs and the
 * lifecycle read one rule.
 */
export const alertWindowOpen = (ride: { status: string; endedAt?: Date | null }, now = Date.now()) =>
   ride.status === RIDE_STATUS.ASSIGNED ||
   ride.status === RIDE_STATUS.STARTED ||
   (ride.status === RIDE_STATUS.COMPLETED &&
      Boolean(ride.endedAt) &&
      now - new Date(ride.endedAt!).getTime() <= ALERT_AFTER_COMPLETED_MS)
