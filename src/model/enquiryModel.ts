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
 * §9.2: the narrow replacement for refunds. The client does not offer refunds,
 * but the system must still record money leaving — chargebacks and duplicate
 * charges happen regardless of policy, and §15 lists "building the system so
 * money can never be recorded as leaving" as a thing to avoid.
 *
 * There is deliberately no customer-facing path to any of these.
 */
export interface IPaymentException extends Document {
   _id: Types.ObjectId
   order: Types.ObjectId
   type: string
   amount: number
   currency: string
   reason: string
   status: string
   /** §9.3: card schemes impose short response deadlines. */
   responseDeadline?: Date
   evidenceSubmittedAt?: Date
   outcome?: string
   recordedBy?: Types.ObjectId
   recordedByEmail?: string
   createdAt: Date
}

const paymentExceptionSchema = new Schema<IPaymentException>(
   {
      order: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
      type: {
         type: String,
         enum: ['CHARGEBACK', 'DUPLICATE_CORRECTION', 'SERVICE_FAILURE', 'PROVIDER_REVERSAL'],
         required: true,
         index: true,
      },
      amount: { type: Number, required: true },
      currency: { type: String, default: 'USD' },
      // §9.2: a mandatory reason note on every one.
      reason: { type: String, required: true },
      status: {
         type: String,
         enum: ['OPEN', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'CLOSED'],
         default: 'OPEN',
         index: true,
      },
      responseDeadline: Date,
      evidenceSubmittedAt: Date,
      outcome: String,
      recordedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
      recordedByEmail: String,
      createdAt: { type: Date, default: Date.now },
   },
   { versionKey: false }
)

export const PaymentException = mongoose.model<IPaymentException>(
   'PaymentException',
   paymentExceptionSchema
)

// ---------------------------------------------------------------------------

/**
 * §11 notification templates. One per event per locale.
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
] as const

export interface INotificationTemplate extends Document {
   event: string
   locale: string
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
      locale: { type: String, required: true },
      channel: {
         type: String,
         enum: ['SMS', 'EMAIL', 'PUSH', 'WHATSAPP'],
         required: true,
      },
      subject: { type: String, default: '' },
      body: { type: String, required: true },
      isActive: { type: Boolean, default: true },
   },
   { timestamps: true, optimisticConcurrency: true }
)

notificationTemplateSchema.index(
   { event: 1, locale: 1, channel: 1 },
   { unique: true }
)

export const NotificationTemplate = mongoose.model<INotificationTemplate>(
   'NotificationTemplate',
   notificationTemplateSchema
)

/** Delivery log (§11) — support must answer "was it delivered?" in one search. */
export interface INotificationLog extends Document {
   event: string
   channel: string
   locale: string
   recipient: string
   order?: Types.ObjectId
   status: string
   providerMessage?: string
   costMinor?: number
   createdAt: Date
}

const notificationLogSchema = new Schema<INotificationLog>(
   {
      event: { type: String, required: true, index: true },
      channel: { type: String, required: true },
      locale: String,
      recipient: { type: String, required: true, index: true },
      order: { type: Schema.Types.ObjectId, ref: 'Order', index: true },
      status: {
         type: String,
         enum: ['QUEUED', 'SENT', 'DELIVERED', 'FAILED'],
         default: 'QUEUED',
      },
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
