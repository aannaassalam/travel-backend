import mongoose, { Document, Schema, Types } from 'mongoose'
import {
   BASE_CURRENCY,
   CURRENCIES,
   DEFAULT_LOCALE,
   LOCALES,
} from '../constants/domain.constants'

/**
 * §12: everything here is changeable without a deployment. §15 lists "making
 * the owner wait for a developer to change a homepage banner or policy text"
 * as a thing to avoid.
 *
 * Single document — there is one platform.
 */
export interface ISettings extends Document {
   companyName: string
   supportEmail: string
   supportPhone: string
   /**
    * Public contact details, shown in the footer, on /contact and in the
    * homepage JSON-LD. They lived in three hardcoded places in the frontend,
    * so moving office or changing a number meant a developer and a deploy —
    * §15 is explicit that anything the office changes is admin-owned config.
    */
   whatsappNumber: string
   streetAddress: string
   city: string
   country: string
   officeHours: string
   enabledLocales: string[]
   defaultLocale: string
   enabledCurrencies: string[]
   baseCurrency: string
   /** §5.1: price edits beyond this percentage need typed confirmation. */
   priceChangeGuardPercent: number
   /** §12 inventory rules. */
   holdTtlOnlineMinutes: number
   holdTtlCashHours: number
   maxConcurrentCashHolds: number
   /** §14.4: PII exports capped per period; raising the cap itself alerts. */
   customerExportRowCap: number
   /** §4.2: at-risk window in days. */
   atRiskWindowDays: number
   /** §7: first contact within this many working hours. */
   enquirySlaHours: number
   /** §14.5: purge passport data this many days after travel. */
   passportRetentionDays: number
   maintenanceMode: boolean
   updatedAt: Date
}

const settingsSchema = new Schema<ISettings>(
   {
      companyName: { type: String, default: 'Travel DRC' },
      supportEmail: { type: String, default: '' },
      supportPhone: { type: String, default: '' },
      whatsappNumber: { type: String, default: '' },
      streetAddress: { type: String, default: '' },
      city: { type: String, default: '' },
      country: { type: String, default: 'CD' },
      officeHours: { type: String, default: '' },
      enabledLocales: { type: [String], default: ['fr', 'en'] },
      defaultLocale: { type: String, enum: LOCALES, default: DEFAULT_LOCALE },
      enabledCurrencies: { type: [String], default: [...CURRENCIES] },
      baseCurrency: { type: String, default: BASE_CURRENCY },
      priceChangeGuardPercent: { type: Number, default: 40 },
      holdTtlOnlineMinutes: { type: Number, default: 20 },
      holdTtlCashHours: { type: Number, default: 48 },
      maxConcurrentCashHolds: { type: Number, default: 3 },
      customerExportRowCap: { type: Number, default: 5000 },
      atRiskWindowDays: { type: Number, default: 7 },
      enquirySlaHours: { type: Number, default: 4 },
      passportRetentionDays: { type: Number, default: 90 },
      maintenanceMode: { type: Boolean, default: false },
   },
   { timestamps: true }
)

const SettingsModel = mongoose.model<ISettings>('Settings', settingsSchema)

/** Creates the singleton on first read so the panel never renders an empty form. */
export const getSettings = async () => {
   const existing = await SettingsModel.findOne()
   return existing || SettingsModel.create({})
}

export default SettingsModel

// ---------------------------------------------------------------------------

/**
 * §10: policies are stored as IMMUTABLE versions. Editing creates a new
 * version; the old one is retained forever because historical orders reference
 * it. Editing text in place would destroy the evidentiary chain every
 * chargeback defence depends on — §15 calls this a hard constraint.
 */
export interface IPolicyVersion extends Document {
   _id: Types.ObjectId
   kind: string
   locale: string
   label: string
   body: string
   isLive: boolean
   createdBy?: Types.ObjectId
   createdAt: Date
}

const policyVersionSchema = new Schema<IPolicyVersion>(
   {
      kind: {
         type: String,
         enum: ['NO_REFUND', 'CANCELLATION', 'TERMS', 'PRIVACY'],
         required: true,
         index: true,
      },
      locale: { type: String, enum: LOCALES, required: true },
      label: { type: String, required: true },
      body: { type: String, required: true },
      isLive: { type: Boolean, default: false, index: true },
      createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
      createdAt: { type: Date, default: Date.now },
   },
   { versionKey: false }
)

// Immutable once written — the same guarantee the audit log gets (§14.6),
// for the same reason: orders point at these and the text must never move.
const BLOCK = ['updateOne', 'updateMany', 'findOneAndReplace', 'replaceOne'] as const
BLOCK.forEach((op) =>
   policyVersionSchema.pre(op as any, function (next: (e?: Error) => void) {
      next(
         new Error(
            `Policy versions are immutable: ${op} is not permitted. Create a new version instead.`
         )
      )
   })
)
policyVersionSchema.pre('save', function (next) {
   // isLive is the one mutable flag — which version is current, not what it says.
   if (!this.isNew && this.isModified() && !this.isModified('isLive')) {
      return next(new Error('Policy text is immutable — create a new version'))
   }
   next()
})

export const PolicyVersion = mongoose.model<IPolicyVersion>(
   'PolicyVersion',
   policyVersionSchema
)
