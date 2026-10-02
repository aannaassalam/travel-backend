import mongoose, { Document, Schema, Types } from 'mongoose'
import { decryptField, encryptField } from '../utils/fieldCrypto'
import {
   BASE_CURRENCY,
   CANCELLATION_REASONS,
   CURRENCIES,
   FULFILMENT_STATUS,
   FulfilmentStatus,
   ORDER_STATUS,
   OrderStatus,
   PAYMENT_METHOD,
   PAYMENT_STATUS,
   PaymentStatus,
   VERTICALS,
} from '../constants/domain.constants'

/**
 * Orders. Three independent status axes (§6.2) because they genuinely move
 * independently: an order can be CONFIRMED + PAID + DOCUMENTS_PENDING, which is
 * exactly the "needs action" case the dashboard surfaces.
 */

/** §6.2: masked by default; unmasking is reason-required and logged (§14.5). */
const travellerSchema = new Schema(
   {
      firstName: String,
      lastName: String,
      dateOfBirth: Date,
      documentType: { type: String, enum: ['PASSPORT', 'ID', 'OTHER'] },
      documentNumber: {
         type: String,
         select: false,
         // §14.5: encrypted at rest with a separate key. Applied at the schema
         // so no controller can write a plaintext passport number by accident.
         set: encryptField,
         get: decryptField,
      },
      nationality: String,
      /** §14.5: purge N days after travel completes (default 90). */
      documentPurgeAfter: Date,
   },
   { _id: true, toObject: { getters: true }, toJSON: { getters: true } }
)

const orderItemSchema = new Schema(
   {
      vertical: { type: String, enum: Object.values(VERTICALS), required: true },
      // Not a hard ref: items must resolve even after a listing is archived.
      listingId: { type: Schema.Types.ObjectId, required: true },
      listingLabel: { type: String, required: true },
      roomTypeId: Schema.Types.ObjectId,
      startDate: Date,
      endDate: Date,
      quantity: { type: Number, required: true, min: 1 },
      /** Minor units, USD base. Snapshotted so later price edits never
       *  retroactively change what a customer was charged. */
      unitSellPrice: { type: Number, required: true },
      unitCostPrice: { type: Number, required: true },
      lineTotal: { type: Number, required: true },
      /** Snapshotted alongside lineTotal so margin never drifts (see orderMath). */
      lineCost: { type: Number },
   },
   { _id: true }
)

/**
 * Where a restaurant order is going.
 *
 * Only restaurant orders carry this — a flight has no address to deliver to.
 * The zone and fee are snapshotted rather than referenced, for the same reason
 * every price on an order is: the office re-drawing its zones next month must
 * not retroactively change what this customer agreed to pay.
 *
 * `fee` is the USD base that reporting sums; `feeCharged` is that fee in the
 * currency actually charged, taken from the typed per-currency price rather
 * than converted (§5).
 */
const deliverySchema = new Schema(
   {
      address: { type: String, required: true, trim: true },
      zoneId: Schema.Types.ObjectId,
      zoneName: String,
      fee: { type: Number, default: 0, min: 0 },
      feeCharged: { type: Number, default: 0, min: 0 },
      etaMinutes: Number,
      /** "Second gate, ask for Papa Jean" — the thing that gets a driver there. */
      notes: String,
   },
   { _id: false }
)

/**
 * §6.2 / §9.3: the consent record is what defends a chargeback. It stores the
 * exact text shown, not a pointer that could later be edited — §10 keeps policy
 * versions immutable for the same reason.
 */
const consentSchema = new Schema(
   {
      policyVersionId: { type: Schema.Types.ObjectId, ref: 'PolicyVersion' },
      policyVersionLabel: String,
      textShown: String,
      locale: String,
      acceptedAt: Date,
      ip: String,
      userAgent: String,
   },
   { _id: false }
)

const timelineSchema = new Schema(
   {
      at: { type: Date, default: Date.now },
      event: { type: String, required: true },
      detail: String,
      /** §6.3: every manual override requires a reason. */
      reason: String,
      actorEmail: String,
   },
   { _id: true }
)

export interface IOrder extends Document {
   _id: Types.ObjectId
   reference: string
   /** §4.6: set by the public checkout so a retried POST replays, never duplicates. */
   idempotencyKey?: string
   /**
    * §BUG-009: who the key belongs to — the signed-in customer id, else the
    * normalised contact phone. A replay only returns this order to the SAME
    * caller; another caller reusing the key is refused, never handed this order.
    */
   idempotencyScope?: string
   /** Rate-plan documents holding stock for this order, so payment commits exactly what was held. */
   heldRatePlanIds?: Types.ObjectId[]
   status: OrderStatus
   paymentStatus: PaymentStatus
   fulfilmentStatus: FulfilmentStatus
   customer: Types.ObjectId
   items: any
   travellers: any
   currency: string
   /** Minor units. `total` is USD base; `chargedTotal` is what they actually paid. */
   total: number
   chargedCurrency: string
   chargedTotal: number
   fxRate: number
   paymentMethod: string
   /** The instrument: MOBILE_MONEY | CARD | WALLET | BANK_TRANSFER | CASH. */
   paymentRail?: string
   /** Provider-side state. Never returned to a client — see presentOrder. */
   payment?: {
      provider: string
      transactionId?: string
      merchantTransactionId?: string
      /**
       * MaxiCash's own payment id, learned from the notification. The only key
       * its status lookup accepts, so without it an order cannot be verified.
       */
      providerPaymentId?: string
      paymentUrl?: string
      /** Provider method that actually settled it: OM, MPESA, VISA… */
      providerMethod?: string
      lastStatus?: string
      lastCheckedAt?: Date
      initializedAt?: Date
   }
   channel: string
   /** §6.1: cash orders auto-release at this deadline. */
   cashDeadline?: Date
   /** §6.1: set when the deadline reminder goes out, so it goes out once. */
   cashReminderSentAt?: Date
   /** Restaurant orders only; see deliverySchema. */
   delivery?: any
   consent?: any
   documents: any
   timeline: any
   internalNotes: string
   cancellationReason?: string
   cancelledAt?: Date
   confirmedAt?: Date
   paidAt?: Date
   travelDate?: Date
   createdAt: Date
   updatedAt: Date
}

const orderSchema = new Schema<IOrder>(
   {
      // §3: the reference read out over the phone is the primary navigation key.
      reference: { type: String, required: true, unique: true, index: true },
      /**
       * §4.6. Sparse because admin-created orders have no key — a plain unique
       * index would let exactly one of them exist and reject every one after.
       */
      idempotencyKey: { type: String, unique: true, sparse: true, index: true },
      /** §BUG-009: scopes a replay to its original caller. */
      idempotencyScope: { type: String },
      heldRatePlanIds: { type: [Schema.Types.ObjectId], default: undefined },
      status: {
         type: String,
         enum: Object.values(ORDER_STATUS),
         default: ORDER_STATUS.DRAFT,
         index: true,
      },
      paymentStatus: {
         type: String,
         enum: Object.values(PAYMENT_STATUS),
         default: PAYMENT_STATUS.UNPAID,
         index: true,
      },
      fulfilmentStatus: {
         type: String,
         enum: Object.values(FULFILMENT_STATUS),
         default: FULFILMENT_STATUS.NOT_STARTED,
         index: true,
      },
      customer: {
         type: Schema.Types.ObjectId,
         ref: 'PlatformCustomer',
         required: true,
         index: true,
      },
      items: { type: [orderItemSchema], default: [] },
      travellers: { type: [travellerSchema], default: [] },
      currency: { type: String, default: BASE_CURRENCY },
      total: { type: Number, required: true, default: 0 },
      chargedCurrency: { type: String, enum: CURRENCIES, default: BASE_CURRENCY },
      chargedTotal: { type: Number, default: 0 },
      fxRate: { type: Number, default: 1 },
      paymentMethod: {
         type: String,
         enum: Object.values(PAYMENT_METHOD),
         default: PAYMENT_METHOD.ONLINE,
      },
      paymentRail: {
         type: String,
         enum: ['MOBILE_MONEY', 'CARD', 'WALLET', 'BANK_TRANSFER', 'CASH'],
      },
      /**
       * Everything the provider gave us for this order.
       *
       * Nothing here is a secret: MaxiCash's checkout session is identified by
       * an opaque LogID and its notification carries no shared token, so there
       * is nothing to hide with `select: false`. It is still absent from the
       * public DTO, which is an explicit allow-list.
       */
      payment: {
         provider: { type: String },
         transactionId: { type: String, index: true, sparse: true },
         merchantTransactionId: { type: String, index: true, sparse: true },
         providerPaymentId: { type: String, index: true, sparse: true },
         paymentUrl: { type: String },
         /**
          * The provider's own method code for the rail that actually paid —
          * `OM`, `MPESA`, `VISA`. Read back from the status check, because the
          * customer chooses on the provider's page, not ours.
          */
         providerMethod: { type: String },
         lastStatus: { type: String },
         lastCheckedAt: { type: Date },
         initializedAt: { type: Date },
      },
      channel: { type: String, enum: ['WEB', 'IOS', 'ANDROID', 'ADMIN'], default: 'WEB' },
      cashDeadline: { type: Date, index: true },
      cashReminderSentAt: Date,
      delivery: deliverySchema,
      consent: consentSchema,
      documents: {
         type: [
            {
               kind: { type: String, enum: ['ETICKET', 'VOUCHER', 'INVOICE'] },
               fileName: String,
               storageKey: String,
               version: { type: Number, default: 1 },
               uploadedAt: { type: Date, default: Date.now },
               uploadedBy: String,
            },
         ],
         default: [],
      },
      timeline: { type: [timelineSchema], default: [] },
      internalNotes: { type: String, default: '' },
      cancellationReason: {
         type: String,
         enum: Object.values(CANCELLATION_REASONS),
      },
      cancelledAt: Date,
      confirmedAt: Date,
      paidAt: Date,
      travelDate: { type: Date, index: true },
   },
   { timestamps: true, optimisticConcurrency: true }
)

/** §6.1 "Needs action": paid but no documents issued. */
orderSchema.index({ paymentStatus: 1, fulfilmentStatus: 1 })

export const Order = mongoose.model<IOrder>('Order', orderSchema)
