import { NextFunction, Request, Response } from 'express'
import { Types } from 'mongoose'
import {
   FULFILMENT_STATUS,
   ONLINE_RAILS,
   onlinePaymentsEnabled,
   ORDER_STATUS,
   OFFLINE_RAILS,
   PAYMENT_METHOD,
   PAYMENT_RAIL,
   PAYMENT_STATUS,
   PaymentRail,
   Currency,
} from '../../constants/domain.constants'
import { presentOrder } from '../../dto/public/order.dto'
import { Order } from '../../model/orderModel'
import { getSettings } from '../../model/settingsModel'
import { commitListing, commitStay } from '../../services/orders/inventory.service'
import {
   SettlementOutcome,
   fetchPaymentStatus,
   initializePayment,
   maxicashEnabled,
   parseNotification,
} from '../../services/payments/maxicash.service'
import { NOTIFICATION_EVENTS } from '../../model/enquiryModel'
import { notifyOrder } from '../../services/notifications/notify.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Online payments, via MaxiCash.
 *
 * The security model in one paragraph: the client may only ever ASK for a
 * payment to start. It cannot say how much, cannot say which order is paid, and
 * cannot report success. The amount comes off the order document, the provider
 * is asked directly what happened, and `settle()` below is the single function
 * in the codebase that can move an order to PAID. A forged webhook, a replayed
 * one, or a hand-typed return URL all end up calling the same status check and
 * getting the same answer as everybody else.
 */

/* ------------------------------------------------------------- settlement */

/**
 * The only path to PAID.
 *
 * Idempotent by construction: an order already PAID returns immediately, so a
 * webhook delivered three times (which providers do) commits stock once. Stock
 * is committed BEFORE the status flips, because a customer whose money we have
 * taken must own the seat even if the process dies on the next line.
 */
const settle = async (
   orderId: Types.ObjectId,
   outcome: SettlementOutcome,
   providerStatus: string
): Promise<void> => {
   const order = await Order.findById(orderId)
   if (!order) return

   order.set('payment.lastStatus', providerStatus)
   order.set('payment.lastCheckedAt', new Date())

   if (order.paymentStatus === PAYMENT_STATUS.PAID) {
      await order.save()
      return
   }
   if (order.status === ORDER_STATUS.CANCELLED) {
      await order.save()
      return
   }

   /**
    * An order that has since become a cash order is owed at the counter. A
    * late "failed" or "pending" from an abandoned online attempt must not move
    * it off the office's cash list; only money actually arriving changes it.
    */
   if (order.paymentMethod === PAYMENT_METHOD.CASH && outcome !== 'PAID') {
      await order.save()
      return
   }

   if (outcome === 'PENDING') {
      if (order.paymentStatus !== PAYMENT_STATUS.PENDING) {
         order.paymentStatus = PAYMENT_STATUS.PENDING
      }
      await order.save()
      return
   }

   if (outcome === 'FAILED') {
      /**
       * The hold is deliberately NOT released here. It expires on its own, and
       * a customer whose card was declined usually retries within seconds —
       * handing their seat to someone else in between is a worse outcome than
       * holding it for the few remaining minutes.
       */
      order.paymentStatus = PAYMENT_STATUS.FAILED
      order.timeline.push({
         event: 'PAYMENT_FAILED',
         detail: `maxicash=${providerStatus}`,
      })
      await order.save()
      return
   }

   // Hold -> sold, per line, before the order is marked paid.
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
      detail: `maxicash=${providerStatus} rail=${order.paymentRail ?? 'ONLINE'}`,
   })
   await order.save()

   void notifyOrder(NOTIFICATION_EVENTS.PAYMENT_RECEIVED, order._id)
}

/**
 * Ask the provider, then act on the answer.
 *
 * Used by both the webhook and the client poll, so there is exactly one
 * interpretation of a provider status anywhere in the system.
 */
const reconcile = async (order: any): Promise<SettlementOutcome> => {
   /**
    * MaxiCash's status lookup takes ITS payment id, not our reference — there
    * is no endpoint that resolves a merchant reference. The id arrives on the
    * notification and is stored then, so an order that has never been notified
    * has nothing to verify against and stays pending. Failing closed is the
    * whole point: PENDING is recoverable, a wrongly-PAID order is not.
    */
   /**
    * Only an order WE opened a payment on can be settled by the provider.
    * `transactionId` is written by `startPayment` and by nothing else, so a
    * cash order — which never reaches the provider — has none and stops here.
    * Without this, anyone who knew a reference could point the webhook at a
    * cash order and have it marked paid or failed.
    */
   if (!order.payment?.transactionId) return 'PENDING'

   const paymentId = order.payment?.providerPaymentId
   if (!paymentId) {
      return 'PENDING'
   }
   const status = await fetchPaymentStatus(paymentId)

   /**
    * A successful payment must be THIS order's payment. The payment id arrives
    * in an unsigned notification, so a genuine id from a small payment could
    * otherwise be replayed against a large order. Where MaxiCash names the
    * reference it was paid against, it has to match; a mismatch is left
    * PENDING for the office to look at, never settled.
    */
   if (status.outcome === 'PAID' && status.reference && status.reference !== order.reference) {
      console.error(
         `[maxicash] payment ${paymentId} belongs to ${status.reference}, not ${order.reference} — not settled`
      )
      return 'PENDING'
   }

   /**
    * §BUG-003: the money must match the order before it is marked PAID. The
    * amount is in the same minor units we sent (toProviderAmount is identity for
    * USD), and the currency is the one the order was priced in. A provider amount
    * or currency that disagrees is left PENDING for the office, never settled —
    * this is what stops a small payment being replayed to clear a large order.
    * (Only checked when the provider actually returns the figure; see the
    * fail-closed note in maxicash.service.)
    */
   if (status.outcome === 'PAID') {
      const expectedAmount = Number(order.chargedTotal ?? order.total)
      const expectedCurrency = String(order.chargedCurrency ?? order.currency ?? '').toUpperCase()
      if (
         (status.amount !== null && status.amount !== expectedAmount) ||
         (status.currency && status.currency !== expectedCurrency)
      ) {
         console.error(
            `[maxicash] amount/currency mismatch for ${order.reference}: ` +
               `provider=${status.amount}/${status.currency} expected=${expectedAmount}/${expectedCurrency} — not settled`
         )
         return 'PENDING'
      }
   }

   await settle(order._id, status.outcome, status.providerStatus)
   return status.outcome
}

/* --------------------------------------------------- POST /orders/:ref/pay */

/**
 * Starts a payment and hands back somewhere to send the customer.
 *
 * Replaces the simulated handler that used to mark orders paid on request —
 * that route could not survive contact with real money, and §9.3 already said
 * the provider must be the source of truth.
 */
export const startPayment = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const reference = String(req.params.reference).toUpperCase()
      const order = await Order.findOne({ reference }).populate(
         'customer',
         'firstName lastName email phone'
      )
      if (!order) return next(new AppError('Order not found', 404))

      if (order.paymentStatus === PAYMENT_STATUS.PAID) {
         return sendResponse(res, 200, 'Already paid', {
            status: 'PAID',
            order: presentOrder(order),
         })
      }
      if (order.status === ORDER_STATUS.CANCELLED) {
         return next(new AppError('This order was cancelled', 409, 'ORDER_CANCELLED'))
      }

      const rail = String(req.body?.rail ?? '').toUpperCase() as PaymentRail

      // Product decision 2026-10-02: cash only in every environment. Refused
      // before anything below can touch the provider.
      if (rail && rail !== PAYMENT_RAIL.CASH) {
         return next(new AppError('Only cash payment is available.', 400, 'CASH_ONLY'))
      }

      /**
       * Cash never reaches the provider — it is money handed over at the
       * counter — so the honest answer is the instructions, not a payment page.
       *
       * Bank transfer used to land here too, because the previous provider had
       * no bank-transfer channel and the office had to reconcile it by hand.
       * MaxiCash settles it, so it is an ordinary online rail now and the
       * dead `settings.bankTransfer` lookup that fed this response is gone
       * along with it.
       */
      if (OFFLINE_RAILS.includes(rail) || order.paymentMethod === PAYMENT_METHOD.CASH) {
         order.paymentRail = OFFLINE_RAILS.includes(rail) ? rail : PAYMENT_RAIL.CASH
         /**
          * Cash chosen on an order that was created for online payment — after
          * a failed attempt, or on an order that straddled the cash-only
          * switch. Setting the rail alone left it an ONLINE order on the short
          * online hold: it never reached the office's cash list and was
          * auto-cancelled minutes after the customer was told to come and pay.
          * So it becomes a cash order in full, with the cash deadline and the
          * SMS that carries the reference to the counter.
          */
         const converted = order.paymentMethod !== PAYMENT_METHOD.CASH
         if (converted) {
            const settings = await getSettings()
            order.paymentMethod = PAYMENT_METHOD.CASH
            order.paymentStatus = PAYMENT_STATUS.UNPAID
            order.cashDeadline = new Date(Date.now() + settings.holdTtlCashHours * 3600_000)
            order.timeline.push({
               event: 'PAYMENT_METHOD_CHANGED',
               detail: 'ONLINE -> CASH at the customer\'s request',
            })
         }
         await order.save()
         if (converted) void notifyOrder(NOTIFICATION_EVENTS.ORDER_CONFIRMED, order._id)
         return sendResponse(res, 200, 'Settle offline', {
            status: 'OFFLINE',
            rail: order.paymentRail,
            reference: order.reference,
         })
      }

      if (!ONLINE_RAILS.includes(rail)) {
         return next(new AppError('Choose a payment method', 400, 'RAIL_INVALID'))
      }
      // Cash-only mode refuses here, before any provider call or link reuse.
      if (!onlinePaymentsEnabled() || !maxicashEnabled()) {
         return next(
            new AppError('Online payment is unavailable', 503, 'PAYMENT_UNAVAILABLE')
         )
      }

      /**
       * A payment is already open on this order — hand back the same page.
       *
       * The reference is the provider's transaction key, and MaxiCash refuses a
       * second transaction under an id it already holds. So re-initialising
       * fails, which is what a customer got for the ordinary act of pressing
       * back and tapping pay again. Reusing the URL is also the correct
       * behaviour rather than merely the working one: two live transactions for
       * one order is how a customer ends up paying twice.
       *
       * Bounded by time: a link older than the hold window may have expired at
       * the provider, and it is better to attempt a fresh one and surface a
       * clear failure than to send someone to a dead page.
       */
      const openedAt = order.payment?.initializedAt?.getTime() ?? 0
      const REUSE_WINDOW_MS = 30 * 60 * 1000
      if (
         order.payment?.paymentUrl &&
         order.paymentStatus === PAYMENT_STATUS.PENDING &&
         Date.now() - openedAt < REUSE_WINDOW_MS
      ) {
         return sendResponse(res, 200, 'Payment already started', {
            status: 'REDIRECT',
            paymentUrl: order.payment.paymentUrl,
            reference: order.reference,
         })
      }

      /**
       * The amount is read off the order, in the currency the order was priced
       * in. Nothing in the request body influences it — that is the difference
       * between a checkout and a donation form.
       */
      const amountMinor = Number(order.chargedTotal ?? order.total)
      const currency = String(order.chargedCurrency ?? order.currency) as Currency

      const c: any = order.customer
      const settings = await getSettings()
      /**
       * MaxiCash wants an e-mail for card payments; this site is deliberately
       * phone-first and treats e-mail as optional, so most orders have none.
       *
       * The chain never dead-ends. It used to 503 when nothing was configured,
       * which meant one blank admin field switched off online payment for
       * everybody — a configuration gap became an outage. The last resort is a
       * no-reply address on the merchant's OWN domain: honest, never a
       * stranger's inbox, and enough for the provider's receipt.
       */
      const merchantHost = (() => {
         try {
            return new URL(String(process.env.FRONTEND_URL)).hostname.replace(/^www\./, '')
         } catch {
            return 'localhost'
         }
      })()
      const email =
         c?.email ||
         process.env.MAXICASH_FALLBACK_EMAIL ||
         settings.supportEmail ||
         `no-reply@${merchantHost}`

      // The provider rejects names shorter than two characters outright.
      const firstName = String(c?.firstName ?? '').trim() || 'Client'
      const lastName = String(c?.lastName ?? '').trim() || firstName

      const init = await initializePayment({
         merchantTransactionId: order.reference,
         amountMinor,
         currency,
         firstName: firstName.length >= 2 ? firstName : `${firstName}.`,
         lastName: lastName.length >= 2 ? lastName : `${lastName}.`,
         email,
         phone: c?.phone,
         locale: String(req.body?.locale ?? 'fr'),
         /** Selects the MaxiCash PayType: VISA, MobileMoney, MaxiCash, BankTransfer. */
         rail,
      })

      order.paymentRail = rail
      order.paymentStatus = PAYMENT_STATUS.PENDING
      order.set('payment', {
         provider: 'MAXICASH',
         /** MaxiCash's LogID — identifies the checkout session, not the payment. */
         transactionId: init.logId,
         merchantTransactionId: order.reference,
         paymentUrl: init.paymentUrl,
         providerMethod: init.payType,
         lastStatus: 'INITIATED',
         initializedAt: new Date(),
      })
      order.timeline.push({ event: 'PAYMENT_STARTED', detail: `maxicash rail=${rail}` })
      await order.save()

      /**
       * Only the URL goes back, and it carries nothing but an opaque LogID. The
       * merchant password never leaves this server — which is the whole reason
       * this integration uses the two-step PayEntryWeb flow rather than the
       * simpler form post, where the password travels through the browser.
       */
      return sendResponse(res, 200, 'Payment started', {
         status: 'REDIRECT',
         paymentUrl: init.paymentUrl,
         reference: order.reference,
      })
   }
)

/* ------------------------------------ POST /payments/maxicash/notify (hook) */

/**
 * MaxiCash's server-to-server notification.
 *
 * Treated as a doorbell, never a delivery. The body tells us WHICH payment
 * changed; what actually happened comes from `reconcile`, which asks MaxiCash
 * directly. So a forged notification achieves nothing beyond making us ask a
 * question we would have asked anyway.
 *
 * That matters more here than it did with the previous provider, because
 * MaxiCash publishes no signature or shared secret on this callback — there is
 * nothing to verify the sender with. The only defence is refusing to believe
 * the body, which is exactly what this does: `claimedStatus` is logged and
 * discarded.
 *
 * MaxiCash does not document the callback's shape either, so body, query and
 * form-encoded parameters are all searched, case-insensitively.
 */
export const maxicashNotify = catchAsync(async (req: Request, res: Response) => {
   // §BUG-003: MaxiCash publishes NO notification signature, HMAC, shared secret
   // or callback IP range (developer.maxicashapp.com EN+FR, verified 2026-10-02;
   // the public SDKs do not parse the callback either) — there is no spec to wait
   // for. Sender authenticity therefore has to come from us: a per-order secret
   // token in the NotifyURL registered with PayEntryWeb (not yet implemented — it
   // needs one sandbox transaction to confirm MaxiCash preserves the query
   // string). Payment truth comes from reconcile(): nothing in this body is
   // trusted, the status is re-fetched server-to-server, and reference, amount
   // and currency are confirmed against the order before it can be marked PAID.
   const n = parseNotification([req.body, req.query as any])

   if (!n.reference && !n.paymentId) {
      return res.status(400).json({ received: false })
   }

   const order = await Order.findOne(
      n.reference
         ? { reference: String(n.reference).toUpperCase() }
         : { 'payment.transactionId': n.paymentId }
   )

   /**
    * 200 for an unknown payment, on purpose. A 404 tells a prober which
    * references exist, and makes MaxiCash retry a notification that will never
    * match anything.
    */
   if (!order) {
      console.warn(`[maxicash] notify for unknown payment ${n.reference ?? n.paymentId}`)
      return res.status(200).json({ received: true })
   }

   // No payment was ever opened on this order (every cash order): nothing a
   // notification says about it can be true, so nothing is stored or asked.
   if (!order.payment?.transactionId) {
      console.warn(`[maxicash] notify for ${order.reference}, which has no open payment — ignored`)
      return res.status(200).json({ received: true })
   }

   /**
    * One payment settles one order. An id already recorded against another
    * order is a replay, whoever sent it.
    *
    * ponytail: check-then-write, so two simultaneous notifications could both
    * pass. A unique index on payment.providerPaymentId closes that; it needs
    * the existing non-unique index dropped first, so it is a migration.
    */
   if (
      n.paymentId &&
      (await Order.exists({
         'payment.providerPaymentId': n.paymentId,
         _id: { $ne: order._id },
      }))
   ) {
      console.error(
         `[maxicash] payment ${n.paymentId} is already recorded on another order — notify for ${order.reference} ignored`
      )
      return res.status(200).json({ received: true })
   }

   /**
    * The payment id is the one thing worth keeping from an unverified body: it
    * is the only key `PayNowStatus` accepts, so without it the order can never
    * be verified at all. It is an input to a question, not an answer — and the
    * two checks above are what stop it being an answer borrowed from somewhere
    * else.
    */
   if (n.paymentId && n.paymentId !== order.payment?.providerPaymentId) {
      await Order.updateOne(
         { _id: order._id },
         { $set: { 'payment.providerPaymentId': n.paymentId } }
      )
      order.set('payment.providerPaymentId', n.paymentId)
   }

   console.log(
      `[maxicash] notify order=${order.reference} claimed=${n.claimedStatus ?? '-'} pmtId=${n.paymentId ?? '-'}`
   )

   await reconcile(order)
   return res.status(200).json({ received: true })
})

/* --------------------------------- GET /orders/:reference/payment (polling) */

/**
 * What the customer's screen polls for the order's payment state.
 *
 * Product decision 2026-10-02: cash only, so this never asks the provider any
 * more — it reports the order's own paymentStatus, which the office sets.
 */
export const paymentStatus = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const reference = String(req.params.reference).toUpperCase()
      const order = await Order.findOne({ reference })
      if (!order) return next(new AppError('Order not found', 404))

      return sendResponse(res, 200, 'OK', {
         reference,
         paymentStatus: order.paymentStatus,
         paid: order.paymentStatus === PAYMENT_STATUS.PAID,
      })
   }
)
