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
   phoneVerifiedAt?: Date
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
      phoneVerifiedAt: Date,
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
