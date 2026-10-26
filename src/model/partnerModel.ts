import mongoose, { Document, Schema, Types } from 'mongoose'

/**
 * A partner the office shows off: a logo in the "Our partners" section of the
 * website's homepage and the app's Explore screen, linking to their website
 * when they have one. Public by design — unlike a supplier, nothing here is
 * internal.
 */
export interface IPartner extends Document {
   _id: Types.ObjectId
   name: string
   /** The address the panel's logo upload answered with (checked on save: partnerController). */
   logo: string
   /** http(s) only, or blank. */
   website: string
   /** Lowest first; ties by name. */
   sortOrder: number
   /** Switched off: kept in the panel, gone from the website and the app. */
   isActive: boolean
   createdAt: Date
   updatedAt: Date
}

const partnerSchema = new Schema<IPartner>(
   {
      name: { type: String, required: true, trim: true, maxlength: 120 },
      logo: { type: String, required: [true, 'Upload the partner’s logo'], maxlength: 500 },
      website: { type: String, default: '', trim: true, maxlength: 500 },
      sortOrder: { type: Number, default: 0 },
      isActive: { type: Boolean, default: true },
   },
   { timestamps: true, optimisticConcurrency: true }
)

export const Partner = mongoose.model<IPartner>('Partner', partnerSchema)
