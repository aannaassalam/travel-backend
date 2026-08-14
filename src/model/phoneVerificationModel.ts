import mongoose, { Document, Schema } from 'mongoose'

/**
 * Outstanding one-time codes.
 *
 * Deliberately NOT fields on the customer: requesting a code is something
 * anyone can do for any number, and hanging that off `PlatformCustomer` would
 * let a stranger fill the office's customer list with rows for numbers that
 * never booked anything. A customer record is created when someone actually
 * transacts; this is just a code waiting to be spent.
 *
 * The document expires on its own — Mongo's TTL monitor removes it — so nothing
 * has to remember to clean up, and an abandoned code cannot sit around being
 * guessable.
 */
export interface IPhoneVerification extends Document {
   phone: string
   /** SHA-256 of the code. A dump must not contain working logins. */
   codeHash: string
   attempts: number
   expiresAt: Date
   lastSentAt: Date
   createdAt: Date
}

const schema = new Schema<IPhoneVerification>(
   {
      phone: { type: String, required: true, unique: true, index: true },
      codeHash: { type: String, required: true },
      attempts: { type: Number, default: 0 },
      expiresAt: { type: Date, required: true },
      lastSentAt: { type: Date, default: Date.now },
   },
   { timestamps: true, collection: 'phone_verifications' }
)

/** TTL: Mongo deletes the row once `expiresAt` passes. */
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const PhoneVerification = mongoose.model<IPhoneVerification>(
   'PhoneVerification',
   schema
)
