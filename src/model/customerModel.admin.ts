import mongoose, { Document, Schema, Types } from 'mongoose'
import { DEFAULT_LOCALE } from '../constants/domain.constants'

/**
 * Platform customers (§8). Separate from the inherited `customerModel.ts`,
 * which is health-consultant scaffolding.
 *
 * Phone is the primary search key (§8) — it is what gets read out on a call.
 */
export interface ICustomer extends Document {
   _id: Types.ObjectId
   firstName: string
   lastName: string
   fullName: string
   email?: string
   phone: string
   locale: string
   city?: string
   isBlocked: boolean
   /**
    * §7.2: an ACCOUNT exists only once the phone has been proved. A guest
    * checkout still files a customer record here — the office needs to know who
    * booked — but that record is a contact, not a login.
    */
   hasAccount: boolean
   passwordChangedAt?: Date
   /**
    * Bcrypt hash. `select: false` — a customer object is passed around freely
    * (the guard puts one on every authenticated request), and a hash that comes
    * along by default eventually ends up in a response body.
    *
    * Set at sign-up, once the phone has been proved. See middleware/customerAuth
    * for why hashing is explicit at the call site rather than a save hook.
    */
   password?: string
   phoneVerifiedAt?: Date
   /** §BUG-016: sessions issued before this are refused — set on logout. */
   tokensValidFrom?: Date
   deletedAt?: Date
   /** §8: unpaid cash orders that never got collected. */
   noShowCount: number
   internalNotes: string
   createdAt: Date
   updatedAt: Date
}

const customerSchema = new Schema<ICustomer>(
   {
      firstName: { type: String, required: true, trim: true },
      lastName: { type: String, default: '', trim: true },
      email: { type: String, lowercase: true, trim: true, index: true },
      phone: {
         type: String,
         required: true,
         trim: true,
         // §BUG-017: the phone IS the identity (§8), so it must be unique. The
         // sign-up and guest-checkout paths already dedupe on phone in code
         // (findOne / findOneAndUpdate-upsert), so new rows cannot collide; this
         // index is the backstop. NOTE: any pre-existing duplicate phones must be
         // merged before this unique index can build — it does not delete data.
         unique: true,
         index: true,
         // E.164 — free-text phone numbers make merge-on-phone (§8) impossible.
         match: [/^\+?[1-9]\d{6,14}$/, 'Phone must be in E.164 format'],
      },
      locale: { type: String, default: DEFAULT_LOCALE },
      city: { type: String, trim: true },
      isBlocked: { type: Boolean, default: false },
      /**
       * An ACCOUNT, as opposed to a contact. False for every guest checkout;
       * only verifying a one-time code sets it. Outstanding codes live in
       * `phone_verifications`, not here — see that model for why.
       */
      hasAccount: { type: Boolean, default: false, index: true },
      password: { type: String, select: false },
      /** Sessions opened before this are refused — see currentCustomer. */
      passwordChangedAt: Date,
      phoneVerifiedAt: Date,
      /** §BUG-016: logout sets this to now; older tokens are then rejected. */
      tokensValidFrom: Date,
      /** §12.4: set when the customer deletes their own account. */
      deletedAt: Date,
      noShowCount: { type: Number, default: 0 },
      internalNotes: { type: String, default: '' },
   },
   {
      timestamps: true,
      optimisticConcurrency: true,
      // Distinct collection: the inherited `customerModel.ts` already registers
      // a `Customer` model (health-consultant scaffolding, with a
      // `consultantType` field) against `customers`. These are different
      // entities and must not share storage.
      collection: 'platform_customers',
   }
)

customerSchema.virtual('fullName').get(function (this: ICustomer) {
   return [this.firstName, this.lastName].filter(Boolean).join(' ')
})

customerSchema.set('toObject', { virtuals: true })
customerSchema.set('toJSON', { virtuals: true })

export const Customer = mongoose.model<ICustomer>('PlatformCustomer', customerSchema)
