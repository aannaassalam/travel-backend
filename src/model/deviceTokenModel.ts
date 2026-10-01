import mongoose, { Document, Schema, Types } from 'mongoose'

/**
 * A phone signed in to the customer app, reachable by push.
 *
 * Keyed by the FCM token, not by customer: a token names one app install, and
 * when someone else signs in on that phone the install now belongs to them.
 * `lastSeenAt` is refreshed every time the app registers (each launch while
 * signed in), so an app deleted months ago stops counting as "has the app".
 */
export interface IDeviceToken extends Document {
   token: string
   customer: Types.ObjectId
   platform: 'ios' | 'android'
   lastSeenAt: Date
}

const deviceTokenSchema = new Schema<IDeviceToken>(
   {
      token: { type: String, required: true, unique: true, maxlength: 4096 },
      customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
      platform: { type: String, enum: ['ios', 'android'], required: true },
      lastSeenAt: { type: Date, default: Date.now },
   },
   { timestamps: true }
)

export const DeviceToken = mongoose.model<IDeviceToken>('DeviceToken', deviceTokenSchema)

/**
 * A device silent for longer than this is treated as not having the app.
 *
 * Seven days, the idle lifetime of a customer session: the app registers on
 * every launch, so a longer silence means the session behind it has lapsed
 * anyway. It is also the longest a deleted app can go on swallowing messages —
 * Firebase keeps accepting pushes for an uninstalled app for a while, and
 * until it says otherwise the customer would get neither push nor SMS.
 */
export const ACTIVE_DEVICE_MS = 7 * 24 * 60 * 60 * 1000
