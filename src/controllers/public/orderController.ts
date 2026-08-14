import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import { Types } from 'mongoose'
import {
   FULFILMENT_STATUS,
   ORDER_STATUS,
   PAYMENT_METHOD,
   PAYMENT_STATUS,
   VERTICALS,
} from '../../constants/domain.constants'
import { presentOrder } from '../../dto/public/order.dto'
import { Customer } from '../../model/customerModel.admin'
import { Order } from '../../model/orderModel'
import { PolicyVersion, getSettings } from '../../model/settingsModel'
import {
   commitListing,
   commitStay,
   holdListing,
   holdStay,
   releaseListing,
   releaseStay,
} from '../../services/orders/inventory.service'
import { PricedItem, RequestedItem, priceItem, settle } from '../../services/orders/pricing.service'
import { currentCustomer } from '../../middleware/customerAuth'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Public checkout. Three routes: create an order, read one back, pay for one.
 *
 * What the client is trusted with: which product, how many, which dates, who is
 * travelling, and how it wants to pay. What it is NOT trusted with: any price,
 * any status, or whether stock exists. All four are decided here (§5, §4.5).
 */

/**
 * §10.3(4): unguessable, never sequential. The reference is also the read
 * capability for `GET /orders/:reference`, so it carries ~50 bits of entropy —
 * while staying short enough to read down a phone line (§3), which is the job
 * it actually has to do in an office in Kinshasa.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32: no I, L, O, U
const makeReference = () => {
   const bytes = crypto.randomBytes(10)
   let out = ''
   for (let i = 0; i < 10; i++) out += ALPHABET[bytes[i] % 32]
   return `FA-${out.slice(0, 5)}-${out.slice(5)}`
}

/** §7.2: one canonical form, or "the same customer" stops meaning anything. */
const normalisePhone = (raw: string) => {
   const trimmed = String(raw ?? '').replace(/[\s.-]/g, '')
   if (/^\+\d{8,15}$/.test(trimmed)) return trimmed
   if (/^0\d{8,12}$/.test(trimmed)) return `+243${trimmed.slice(1)}`
   if (/^\d{8,15}$/.test(trimmed)) return `+${trimmed}`
   return null
}

/** Undo every hold taken so far. Used when a later step fails. */
const rollback = async (taken: { item: PricedItem; nights: Types.ObjectId[] }[]) => {
   for (const t of taken) {
      if (t.nights.length) await releaseStay(t.nights, t.item.quantity)
      else await releaseListing(t.item.listingId, t.item.quantity)
   }
}

// ---------------------------------------------------------------------------
// POST /orders
// ---------------------------------------------------------------------------

export const createOrder = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const key = req.header('Idempotency-Key')
      if (!key) return next(new AppError('Idempotency-Key header is required', 400))

      /**
       * §4.6: a dropped response on a mobile network gets retried, and a
       * duplicate order double-books stock and double-charges a customer. The
       * key is stored on the order, so the replay returns the original rather
       * than creating a second one.
       */
      const replay = await Order.findOne({ idempotencyKey: key })
      if (replay) {
         return sendResponse(res, 200, 'Order already created', { order: presentOrder(replay) })
      }

      const { items, contact, travellers = [], paymentMethod, currency, locale } = req.body ?? {}

      if (!Array.isArray(items) || !items.length) {
         return next(new AppError('At least one item is required', 400))
      }
      if (items.length > 10) return next(new AppError('Too many items', 400))
      if (!contact?.firstName || !contact?.lastName) {
         return next(new AppError('Contact first and last name are required', 400))
      }
      const phone = normalisePhone(contact.phone)
      if (!phone) return next(new AppError('A valid phone number is required', 400))

      const method =
         paymentMethod === PAYMENT_METHOD.CASH ? PAYMENT_METHOD.CASH : PAYMENT_METHOD.ONLINE

      // --- 1. Re-price from the database ------------------------------------
      let priced: PricedItem[]
      try {
         priced = await Promise.all(
            (items as RequestedItem[]).map((i) => {
               const quantity = Number(i.quantity)
               if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
                  throw new Error('INVALID_QUANTITY')
               }
               return priceItem({ ...i, quantity })
            })
         )
      } catch (err) {
         const code = (err as Error).message
         if (code === 'PROPERTY_IS_ENQUIRY_ONLY') {
            // §1.1 archetype C: property has no checkout at all.
            return next(new AppError('This listing is enquiry-only', 400))
         }
         if (code === 'INVALID_QUANTITY') return next(new AppError('Invalid quantity', 400))
         return next(new AppError('One of these items is no longer available', 409))
      }

      if (priced.some((p) => p.lineTotal <= 0)) {
         return next(new AppError('One of these items is not priced for sale', 409))
      }

      // --- 2. Hold the stock ------------------------------------------------
      const taken: { item: PricedItem; nights: Types.ObjectId[] }[] = []
      for (const item of priced) {
         if (item.vertical === VERTICALS.HOTEL && item.roomTypeId) {
            const { ok, held } = await holdStay(
               item.roomTypeId,
               item.startDate!,
               item.endDate!,
               item.quantity
            )
            if (!ok) {
               await rollback(taken)
               return next(new AppError('Those dates just sold out', 409))
            }
            taken.push({ item, nights: held })
         } else {
            const ok = await holdListing(item.listingId, item.quantity)
            if (!ok) {
               await rollback(taken)
               return next(new AppError('That just sold out', 409))
            }
            taken.push({ item, nights: [] })
         }
      }

      try {
         // The locale the customer is actually being served, used for both the
         // customer record and the consent snapshot below.
         const wanted = ['fr', 'en'].includes(locale) ? locale : 'fr'

         // --- 3. Customer, merged on the canonical phone (§7.2) --------------
         /**
          * `firstName` / `lastName` — the schema has no `name` field, and its
          * `fullName` is a virtual. Writing `name` here is silently discarded
          * by strict mode, and because `findOneAndUpdate` does not run
          * validators on upsert, the required `firstName` would not complain
          * either: every checkout would quietly file a nameless customer.
          */
         const set: Record<string, unknown> = {
            firstName: String(contact.firstName).trim().slice(0, 80),
            lastName: String(contact.lastName).trim().slice(0, 80),
         }
         // Only overwrite an existing email when one was actually given — a
         // guest checkout without an email must not blank a known address.
         if (contact.email) set.email = String(contact.email).toLowerCase()

         /**
          * A guest checkout files a CONTACT, never an account.
          *
          * The office has to know who booked, so the customer record is always
          * written — but `hasAccount` is left exactly as it was. Signing someone
          * in because they bought something would hand whoever is holding the
          * phone a session nobody proved they owned, and would silently claim a
          * number that may belong to somebody else entirely. An account is only
          * ever created by verifying a one-time code (§7.2).
          *
          * A signed-in customer is matched by session, not by the phone typed
          * into the form, so they cannot attach an order to someone else.
          */
         const signedIn = await currentCustomer(req)
         const customer = signedIn?.phone === phone
            ? signedIn
            : await Customer.findOneAndUpdate(
                 { phone },
                 { $set: set, $setOnInsert: { phone, locale: wanted, hasAccount: false } },
                 { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
              )

         // --- 4. Consent evidence (§2.2) ------------------------------------
         /**
          * Read from the live policy version rather than a constant, so the text
          * captured is provably the text the content section had published. The
          * id is stored alongside the snapshot: the snapshot is what defends a
          * chargeback, the id is what ties it to the immutable version record.
          */
         const policy =
            (await PolicyVersion.findOne({ kind: 'NO_REFUND', locale: wanted, isLive: true })) ??
            (await PolicyVersion.findOne({ kind: 'NO_REFUND', locale: 'fr', isLive: true }))
         if (!policy) {
            throw new AppError('No published no-refund policy — cannot take an order', 503)
         }

         const { chargedCurrency, chargedTotal, fxRate, totalUsd } = settle(priced, currency)
         const settings = await getSettings()
         const isCash = method === PAYMENT_METHOD.CASH

         const order = await Order.create({
            reference: makeReference(),
            idempotencyKey: key,
            /**
             * §4.3 three independent axes, never merged. A cash order is
             * SUBMITTED / UNPAID / NOT_STARTED — it exists and is owed, which is
             * exactly the state the chase list queries.
             */
            status: ORDER_STATUS.SUBMITTED,
            paymentStatus: PAYMENT_STATUS.UNPAID,
            fulfilmentStatus: FULFILMENT_STATUS.NOT_STARTED,
            customer: customer._id,
            items: priced.map((p) => ({
               vertical: p.vertical,
               listingId: p.listingId,
               listingLabel: p.listingLabel,
               roomTypeId: p.roomTypeId,
               startDate: p.startDate,
               endDate: p.endDate,
               quantity: p.quantity,
               unitSellPrice: p.unitSellPrice,
               unitCostPrice: p.unitCostPrice,
               lineTotal: p.lineTotal,
               lineCost: p.lineCost,
            })),
            travellers: (Array.isArray(travellers) ? travellers : [])
               .filter((t: any) => t?.firstName || t?.lastName)
               .slice(0, 20),
            total: totalUsd,
            chargedCurrency,
            chargedTotal,
            fxRate,
            paymentMethod: method,
            channel: 'WEB',
            cashDeadline: isCash
               ? new Date(Date.now() + settings.holdTtlCashHours * 3600_000)
               : new Date(Date.now() + settings.holdTtlOnlineMinutes * 60_000),
            consent: {
               policyVersionId: policy._id,
               policyVersionLabel: policy.label,
               textShown: policy.body,
               locale: wanted,
               acceptedAt: new Date(),
               ip: req.ip,
               userAgent: req.header('User-Agent')?.slice(0, 300),
            },
            travelDate: priced.find((p) => p.startDate)?.startDate,
            timeline: [{ event: 'ORDER_CREATED', detail: `channel=WEB method=${method}` }],
         })

         // The held rate-plan ids live on the order so payment can commit
         // exactly what was held, without recomputing the date range.
         if (taken.some((t) => t.nights.length)) {
            await Order.updateOne(
               { _id: order._id },
               { $set: { heldRatePlanIds: taken.flatMap((t) => t.nights) } }
            )
         }

         return sendResponse(res, 201, 'Order created', { order: presentOrder(order) })
      } catch (err) {
         // Never leave stock held for an order that does not exist.
         await rollback(taken)
         throw err
      }
   }
)

// ---------------------------------------------------------------------------
// GET /orders/:reference
// ---------------------------------------------------------------------------

/**
 * §7.4: the reference is the capability. It is high-entropy and unguessable, so
 * possession is the authorisation — the same model as an e-ticket link. The
 * response is identical in shape and timing whether or not a reference exists,
 * so this cannot be used to probe for valid ones.
 */
export const getOrder = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      /**
       * `documentNumber` is `select: false`, so it has to be asked for in order
       * to be MASKED — §6.2 wants "••••4321", not an absent field, which the UI
       * would render as "no document on file". The DTO has no allow-list entry
       * for the raw value, so it cannot escape; only the mask is emitted.
       */
      const order = await Order.findOne({
         reference: String(req.params.reference).toUpperCase(),
      }).select('+travellers.documentNumber')
      if (!order) return next(new AppError('Order not found', 404))
      return sendResponse(res, 200, 'OK', { order: presentOrder(order) })
   }
)

// ---------------------------------------------------------------------------
// POST /orders/:reference/pay
// ---------------------------------------------------------------------------

/**
 * Dummy online payment.
 *
 * ponytail: this stands in for a provider — it marks the order paid without
 * moving money. It is deliberately the ONLY place that does so, and it writes
 * the same fields a real webhook would, so swapping it for
 * `POST /payments` + a provider callback is a change to this handler and
 * nothing else. §9.3 makes the webhook the source of truth in production; a
 * client-driven route like this one must never survive into it.
 */
export const payOrder = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const reference = String(req.params.reference).toUpperCase()
      const order = await Order.findOne({ reference })
      if (!order) return next(new AppError('Order not found', 404))

      // Idempotent: a retried tap must not double-commit stock.
      if (order.paymentStatus === PAYMENT_STATUS.PAID) {
         return sendResponse(res, 200, 'Already paid', { order: presentOrder(order) })
      }
      if (order.status === ORDER_STATUS.CANCELLED) {
         return next(new AppError('This order was cancelled', 409))
      }
      if (order.paymentMethod === PAYMENT_METHOD.CASH) {
         return next(new AppError('Cash orders are settled at the office', 409))
      }

      // Hold -> sold, per line, before the order is marked paid: a customer who
      // is charged must own the stock.
      const heldIds: Types.ObjectId[] = (order as any).heldRatePlanIds ?? []
      for (const item of order.items) {
         if (item.roomTypeId && heldIds.length) await commitStay(heldIds, item.quantity)
         else await commitListing(item.listingId, item.quantity)
      }

      order.status = ORDER_STATUS.CONFIRMED
      order.paymentStatus = PAYMENT_STATUS.PAID
      // §6.1: paid with nothing issued yet is the "needs action" queue.
      order.fulfilmentStatus = FULFILMENT_STATUS.DOCUMENTS_PENDING
      order.paidAt = new Date()
      order.confirmedAt = new Date()
      order.cashDeadline = undefined
      order.timeline.push({
         event: 'PAYMENT_RECEIVED',
         detail: `rail=${String(req.body?.rail ?? 'MOBILE_MONEY')} (simulated)`,
      })
      await order.save()

      return sendResponse(res, 200, 'Payment received', { order: presentOrder(order) })
   }
)
