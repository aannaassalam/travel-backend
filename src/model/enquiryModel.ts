import mongoose, { Document, Schema, Types } from 'mongoose'
import { VERTICALS } from '../constants/domain.constants'

/**
 * §7: property is enquiry-driven and request-to-book is the recovery path for
 * thin inventory. Together a meaningful share of revenue — so this is a small
 * CRM, not a contact-form inbox.
 */

export const ENQUIRY_STAGES = {
   NEW: 'NEW',
   CONTACTED: 'CONTACTED',
   QUALIFIED: 'QUALIFIED',
   QUOTED: 'QUOTED',
   WON: 'WON',
   LOST: 'LOST',
} as const
export type EnquiryStage = (typeof ENQUIRY_STAGES)[keyof typeof ENQUIRY_STAGES]

export const ENQUIRY_KINDS = {
   PROPERTY: 'PROPERTY',
   REQUEST_TO_BOOK: 'REQUEST_TO_BOOK',
} as const

/** §15: free text where an enum belongs destroys reporting within weeks. */
export const LOSS_REASONS = {
   PRICE: 'PRICE',
   NO_AVAILABILITY: 'NO_AVAILABILITY',
   UNRESPONSIVE: 'UNRESPONSIVE',
   CHOSE_COMPETITOR: 'CHOSE_COMPETITOR',
   NOT_SERIOUS: 'NOT_SERIOUS',
   OTHER: 'OTHER',
} as const

export interface IEnquiry extends Document {
   _id: Types.ObjectId
   reference: string
   kind: string
   stage: EnquiryStage
   vertical: string
   customerName: string
   phone: string
   email?: string
   message: string
   listingId?: Types.ObjectId
   listingLabel?: string
   source: string
   /** §7: SLA timer runs from creation until first contact. */
   firstContactAt?: Date
   lossReason?: string
   contactLog: any
   quotedAmount?: number
   quoteExpiresAt?: Date
   convertedOrder?: Types.ObjectId
   createdAt: Date
   updatedAt: Date
}

const enquirySchema = new Schema<IEnquiry>(
   {
      reference: { type: String, required: true, unique: true, index: true },
      kind: {
         type: String,
         enum: Object.values(ENQUIRY_KINDS),
         default: ENQUIRY_KINDS.PROPERTY,
         index: true,
      },
      stage: {
         type: String,
         enum: Object.values(ENQUIRY_STAGES),
         default: ENQUIRY_STAGES.NEW,
         index: true,
      },
      vertical: {
         type: String,
         enum: Object.values(VERTICALS),
         default: VERTICALS.PROPERTY,
      },
      customerName: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true, index: true },
      email: { type: String, lowercase: true, trim: true },
      message: { type: String, default: '' },
      listingId: Schema.Types.ObjectId,
      listingLabel: String,
      source: { type: String, default: 'WEB' },
      firstContactAt: Date,
      lossReason: { type: String, enum: Object.values(LOSS_REASONS) },
      contactLog: {
         type: [
            {
               at: { type: Date, default: Date.now },
               kind: { type: String, enum: ['CALL', 'NOTE', 'QUOTE', 'VIEWING'] },
               detail: String,
               actorEmail: String,
            },
         ],
         default: [],
      },
      /** Minor units, USD base — same money model as everything else. */
      quotedAmount: Number,
      quoteExpiresAt: Date,
      convertedOrder: { type: Schema.Types.ObjectId, ref: 'Order' },
   },
   { timestamps: true, optimisticConcurrency: true }
)

export const Enquiry = mongoose.model<IEnquiry>('Enquiry', enquirySchema)

// ---------------------------------------------------------------------------

/**
 * §11 notification templates. One per event per channel.
 *
 * Deliberately NOT per locale. An SMS is often the first thing we send a phone
 * number, before any customer record exists to hold a language preference - the
 * sign-in code is exactly that case. Guessing wrong is worse than picking one
 * language and being consistent, so operational messages are English.
 *
 * The legal text in PolicyVersion is a different matter and stays bilingual:
 * the site knows which language it is rendering, and consent has to be in a
 * language the customer actually read.
 *
 * §11 is explicit that notification content must NOT contain sensitive data —
 * no passport numbers, no full payment details, no permanent document links.
 * SMS is unencrypted in transit and persists on handsets indefinitely, so that
 * rule is enforced on save rather than left to whoever writes the copy.
 */
export const NOTIFICATION_EVENTS = {
   ORDER_CONFIRMED: 'ORDER_CONFIRMED',
   PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
   CASH_DEADLINE_REMINDER: 'CASH_DEADLINE_REMINDER',
   DOCUMENTS_ISSUED: 'DOCUMENTS_ISSUED',
   ORDER_CANCELLED: 'ORDER_CANCELLED',
   ENQUIRY_RECEIVED: 'ENQUIRY_RECEIVED',
   QUOTE_SENT: 'QUOTE_SENT',
} as const

/** §11: a documented variable list, validated on save. */
export const TEMPLATE_VARIABLES = [
   'customer_name',
   'order_ref',
   'amount',
   'currency',
   'departure_date',
   'listing_title',
   'deadline',
   /**
    * The customer's link to their own order. This is what lets a GUEST track a
    * booking: the reference is the read capability, so possession of the link
    * is the authorisation - no account, no password, nothing to remember.
    */
   'order_link',
] as const

/**
 * SMS and push. Kept beside the schema enum below because the two must agree —
 * and the controller has to check this list by hand, since a field used in an
 * upsert filter is never validated by mongoose.
 */
export const NOTIFICATION_CHANNELS = ['SMS', 'PUSH'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export interface INotificationTemplate extends Document {
   event: string
   channel: string
   subject: string
   body: string
   isActive: boolean
   updatedAt: Date
}

const notificationTemplateSchema = new Schema<INotificationTemplate>(
   {
      event: {
         type: String,
         enum: Object.values(NOTIFICATION_EVENTS),
         required: true,
         index: true,
      },
      /**
       * SMS and push only. Email was removed because this market reaches
       * customers on a handset — and every extra channel is another template
       * per event per locale for the office to keep correct, for an address
       * most customers never gave us.
       */
      channel: {
         type: String,
         enum: NOTIFICATION_CHANNELS,
         required: true,
      },
      subject: { type: String, default: '' },
      body: { type: String, required: true },
      isActive: { type: Boolean, default: true },
   },
   { timestamps: true, optimisticConcurrency: true }
)

notificationTemplateSchema.index({ event: 1, channel: 1 }, { unique: true })

export const NotificationTemplate = mongoose.model<INotificationTemplate>(
   'NotificationTemplate',
   notificationTemplateSchema
)

/** Delivery log (§11) — support must answer "was it delivered?" in one search. */
export interface INotificationLog extends Document {
   event: string
   channel: string
   recipient: string
   order?: Types.ObjectId
   status: string
   /** What was actually sent. Support is asked what the customer read, not
    *  only whether something left the building. */
   body?: string
   providerMessage?: string
   costMinor?: number
   createdAt: Date
}

const notificationLogSchema = new Schema<INotificationLog>(
   {
      event: { type: String, required: true, index: true },
      channel: { type: String, required: true },
      recipient: { type: String, required: true, index: true },
      order: { type: Schema.Types.ObjectId, ref: 'Order', index: true },
      status: {
         type: String,
         enum: ['QUEUED', 'SENT', 'DELIVERED', 'FAILED'],
         default: 'QUEUED',
      },
      body: { type: String, maxlength: 1000 },
      providerMessage: String,
      costMinor: Number,
      createdAt: { type: Date, default: Date.now },
   },
   { versionKey: false }
)

export const NotificationLog = mongoose.model<INotificationLog>(
   'NotificationLog',
   notificationLogSchema
)
