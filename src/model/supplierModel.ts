import mongoose, { Document, Schema, Types } from 'mongoose'

/**
 * Who the office buys from: a hotel, an airline or bus company (the "travel
 * agency" of a route), a car hire firm, a property owner, a tour operator.
 *
 * Recorded once and picked from a list on every hotel and listing, so the
 * team can reach the supplier from a booking without whoever entered it.
 * Internal only: the public catalogue never carries a supplier (§14.3), except
 * that a bus or flight route shows its agency's name as the operator — see
 * `syncOperatorName`.
 */
export interface ISupplier extends Document {
   _id: Types.ObjectId
   name: string
   phone: string
   email: string
   contactName: string
   address: string
   notes: string
   /** Switched off rather than deleted while anything still points at it. */
   isActive: boolean
   createdAt: Date
   updatedAt: Date
}

const supplierSchema = new Schema<ISupplier>(
   {
      name: { type: String, required: true, trim: true, maxlength: 200, index: true },
      phone: { type: String, default: '', trim: true, maxlength: 40 },
      email: { type: String, default: '', trim: true, lowercase: true, maxlength: 200 },
      contactName: { type: String, default: '', trim: true, maxlength: 200 },
      address: { type: String, default: '', trim: true, maxlength: 500 },
      notes: { type: String, default: '', trim: true, maxlength: 2000 },
      isActive: { type: Boolean, default: true, index: true },
   },
   { timestamps: true, optimisticConcurrency: true }
)

export const Supplier = mongoose.model<ISupplier>('Supplier', supplierSchema)
