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

/**
 * One office, for the footer and the contact page. The office has several of
 * them in several cities; the primary one is the public site's main contact.
 */
export interface IOffice {
   _id: Types.ObjectId
   name: string
   city: string
   streetAddress: string
   phone: string
   whatsapp: string
   email: string
   hours: string
   geo?: { lat: number; lng: number }
   /** Exactly one — it fills the legacy single-office fields on the public API. */
   isPrimary: boolean
}

const officeSchema = new Schema<IOffice>(
   {
      name: { type: String, required: true, trim: true },
      city: { type: String, required: true, trim: true },
      streetAddress: { type: String, default: '' },
      phone: { type: String, default: '' },
      whatsapp: { type: String, default: '' },
      email: { type: String, default: '' },
      hours: { type: String, default: '' },
      geo: { lat: Number, lng: Number },
      isPrimary: { type: Boolean, default: false },
   },
   { _id: true }
)

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
   offices: IOffice[]
   enabledLocales: string[]
   defaultLocale: string
   enabledCurrencies: string[]
   baseCurrency: string
   /**
    * How many francs 1 USD and 1 EUR are worth, as the office types them.
    * Prices are entered in francs only; every USD and EUR price is worked out
    * from these (fx.service). Unset means that currency is not offered.
    */
   exchangeRates: { USD?: number; EUR?: number }
   /** §5.1: price edits beyond this percentage need typed confirmation. */
   priceChangeGuardPercent: number
   /** §12 inventory rules. */
   holdTtlOnlineMinutes: number
   holdTtlCashHours: number
   maxConcurrentCashHolds: number
   /** §14.4: PII exports capped per period; raising the cap itself alerts. */
   customerExportRowCap: number
   /**
    * §4.2: at-risk window in days. Nothing reads it since the dashboard dropped
    * its unsold-stock figures (2026-10-23), so Settings no longer shows it; the
    * field stays so stored documents need no migration if it comes back.
    */
   atRiskWindowDays: number
   /** §7: first contact within this many working hours. */
   enquirySlaHours: number
   /** §14.5: purge passport data this many days after travel. */
   passportRetentionDays: number
   maintenanceMode: boolean
   /**
    * Transfers. Where a security alert from a ride is texted (E.164); blank
    * means the primary office's phone. The detour factor turns a straight line
    * into a road estimate when the routing service cannot be reached.
    */
   transferAlertPhone: string
   transferDetourFactor: number
   updatedAt: Date
}

const settingsSchema = new Schema<ISettings>(
   {
      companyName: { type: String, default: 'Flexi Agency' },
      supportEmail: { type: String, default: '' },
      supportPhone: { type: String, default: '' },
      offices: { type: [officeSchema], default: [] },
      enabledLocales: { type: [String], default: ['fr', 'en'] },
      defaultLocale: { type: String, enum: LOCALES, default: DEFAULT_LOCALE },
      enabledCurrencies: { type: [String], default: [...CURRENCIES] },
      baseCurrency: { type: String, default: BASE_CURRENCY },
      exchangeRates: {
         USD: { type: Number, min: 0.000001, max: 10_000_000 },
         EUR: { type: Number, min: 0.000001, max: 10_000_000 },
      },
      // Bounded + required: updateSettings copies the body onto the doc and
      // save() validates, so a 0/negative/null value (which would e.g. purge
      // every passport or expire every hold instantly) is refused as a 400.
      priceChangeGuardPercent: { type: Number, default: 40, required: true, min: 0, max: 100 },
      holdTtlOnlineMinutes: { type: Number, default: 20, required: true, min: 1, max: 1440 },
      holdTtlCashHours: { type: Number, default: 48, required: true, min: 1, max: 720 },
      maxConcurrentCashHolds: { type: Number, default: 3, required: true, min: 1, max: 50 },
      customerExportRowCap: { type: Number, default: 5000, required: true, min: 1, max: 100000 },
      atRiskWindowDays: { type: Number, default: 7, required: true, min: 1, max: 365 },
      enquirySlaHours: { type: Number, default: 4, required: true, min: 1, max: 720 },
      passportRetentionDays: { type: Number, default: 90, required: true, min: 1, max: 3650 },
      maintenanceMode: { type: Boolean, default: false },
      transferAlertPhone: { type: String, default: '', trim: true, maxlength: 20 },
      transferDetourFactor: { type: Number, default: 1.3, required: true, min: 1, max: 3 },
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
   /** When it first went on the website. From then on it is part of the record of what applied when, and is kept. */
   wentLiveAt?: Date
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
      // Written together with isLive, the one change the hook below allows.
      wentLiveAt: Date,
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
