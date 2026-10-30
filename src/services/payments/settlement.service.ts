import { Types } from 'mongoose'
import {
   FULFILMENT_STATUS,
   ORDER_STATUS,
   PAYMENT_METHOD,
   PAYMENT_STATUS,
} from '../../constants/domain.constants'
import { NOTIFICATION_EVENTS } from '../../model/enquiryModel'
import { Order } from '../../model/orderModel'
import { getSettings } from '../../model/settingsModel'
import { notifyOrder } from '../notifications/notify.service'
import { commitOrderStock } from '../orders/inventory.service'
import { SettlementOutcome, checkPaymentStatus, maxicashEnabled } from './maxicash.service'

/**
 * How an order becomes paid online.
 *
 * `settle()` is the single function in the codebase that can move an order to
 * PAID through MaxiCash. It is reached two ways, and both are MaxiCash
 * speaking, never the customer: MaxiCash's call on the address made for one
 * attempt on one order (the notification), and MaxiCash's answer to this
 * server's own, authenticated question about the order's reference
 * (`askMaxicash`). Nothing a browser or an app sends reaches it.
 */

/**
 * A load-change-save that lost a race with another writer of the same order
 * (MaxiCash's call and the customer's return land within a second of each
 * other) is run again on the order as it now stands.
 */
export const again = async <T>(work: () => Promise<T>): Promise<T> => {
   for (let attempt = 0; ; attempt++) {
      try {
         return await work()
      } catch (err) {
         if ((err as Error)?.name !== 'VersionError' || attempt >= 3) throw err
      }
   }
}

/* ------------------------------------------------------------- settlement */

/**
 * The only path to PAID.
 *
 * Idempotent by construction: an order already PAID returns immediately, and
 * the hold is turned into a sale by `commitOrderStock`, which does it once
 * however this is reached — a notification delivered three times (which
 * providers do), two at the same moment, or this block run again after losing
 * a race with another writer. Stock is committed BEFORE the status flips,
 * because a customer whose money we have taken must own the seat even if the
 * process dies on the next line.
 */
export const settle = (
   orderId: Types.ObjectId,
   outcome: SettlementOutcome,
   providerStatus: string
): Promise<void> =>
   again(async () => {
      const order = await Order.findById(orderId)
      if (!order) return

      const said = order.payment?.lastStatus
      order.set('payment.lastStatus', providerStatus)
      order.set('payment.lastCheckedAt', new Date())

      if (order.paymentStatus === PAYMENT_STATUS.PAID) {
         await order.save()
         return
      }

      if (order.status === ORDER_STATUS.CANCELLED) {
         /**
          * Money for a booking that has already been given up — it sat on the
          * payment page past its hold. The seat may be gone, so nothing here
          * can honour it; what must not happen is the money going unseen. It
          * is recorded as paid on the cancelled order, which puts it in front
          * of the office (paid, nothing issued) to rebook or refund.
          */
         if (outcome === 'PAID') {
            order.paymentStatus = PAYMENT_STATUS.PAID
            order.paymentMethod = PAYMENT_METHOD.ONLINE
            order.paidAt = new Date()
            order.timeline.push({
               event: 'PAYMENT_RECEIVED',
               // (said in words first: the panel hides a detail that is only a code)
               detail: `Paid through MaxiCash after this booking was cancelled — rebook it or refund the customer (maxicash=${providerStatus})`,
            })
         }
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
         /**
          * MaxiCash has said something about this payment that could not be
          * read as "paid" or "failed". It may well be money. So the booking is
          * not let go on the short online hold: it waits as long as a cash one
          * would, under the office's "needs action" (see `paymentAwaited`),
          * where someone can check the MaxiCash account and settle it by hand.
          */
         const settings = await getSettings()
         const until = new Date(Date.now() + settings.holdTtlCashHours * 3600_000)
         if (!order.cashDeadline || order.cashDeadline < until) order.cashDeadline = until
         // Said once per wording, so the office can see what did arrive.
         if (said !== providerStatus) {
            order.timeline.push({
               event: 'PAYMENT_NOTIFIED',
               detail: `MaxiCash sent "${providerStatus}" — not taken as a payment; check the MaxiCash account`,
            })
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
         if (order.paymentStatus !== PAYMENT_STATUS.FAILED) {
            order.paymentStatus = PAYMENT_STATUS.FAILED
            order.timeline.push({
               event: 'PAYMENT_FAILED',
               detail: `maxicash=${providerStatus}`,
            })
         }
         await order.save()
         return
      }

      // Hold -> sold, before the order is marked paid — and once only.
      await commitOrderStock(order)

      order.status = ORDER_STATUS.CONFIRMED
      order.paymentStatus = PAYMENT_STATUS.PAID
      // Paid through MaxiCash, whatever it was booked as: an order switched to
      // cash while its payment page was still open is not a cash order now.
      order.paymentMethod = PAYMENT_METHOD.ONLINE
      // §6.1: paid with nothing issued yet is the "needs action" queue.
      order.fulfilmentStatus = FULFILMENT_STATUS.DOCUMENTS_PENDING
      order.paidAt = new Date()
      order.confirmedAt = new Date()
      order.cashDeadline = undefined
      order.timeline.push({
         event: 'PAYMENT_RECEIVED',
         detail: `maxicash=${providerStatus}`,
      })
      await order.save()

      /**
       * A booking first filed for cash (or switched to it) was texted and
       * e-mailed as new then; this is its payment. One paid online straight
       * away is new now: its first text, and the office's first word of it.
       */
      const filedForCash = order.timeline.some(
         (t: any) =>
            t.event === 'PAYMENT_METHOD_CHANGED' ||
            (t.event === 'ORDER_CREATED' && String(t.detail ?? '').includes('method=CASH'))
      )
      void notifyOrder(
         NOTIFICATION_EVENTS.PAYMENT_RECEIVED,
         order._id,
         filedForCash ? { office: 'PAID' } : { sms: true, office: 'NEW_PAID' }
      )
   })

/* ------------------------------------------------------ asking MaxiCash */

/** Not more often than this per order: screens poll, and each ask is a call to MaxiCash. */
const ASK_EVERY_MS = 10_000

/**
 * Asks MaxiCash whether this order's reference has been paid, and settles the
 * order if it says so. True when the order is paid as a result.
 *
 * This is what makes a lost or unreadable notification harmless: the customer
 * who comes back from MaxiCash's page, the screen that is waiting, and the
 * job about to release an unpaid booking all ask before giving up.
 *
 * Only "paid" is ever taken from the answer. MaxiCash says "failed" both for
 * a payment that failed and for one that has not been made yet, so anything
 * else changes nothing. Never throws: MaxiCash being unreachable is "do not
 * know", and the caller carries on as it would have.
 */
export const askMaxicash = async (order: {
   _id: Types.ObjectId
   reference: string
   paymentStatus?: string
   payment?: { attempts?: unknown[]; lastAskedAt?: Date } | null
}): Promise<boolean> => {
   if (order.paymentStatus === PAYMENT_STATUS.PAID) return true
   // Nothing was ever opened at MaxiCash for this order: nothing to ask about.
   if (!order.payment?.attempts?.length || !maxicashEnabled()) return false
   const last = order.payment.lastAskedAt?.getTime() ?? 0
   if (Date.now() - last < ASK_EVERY_MS) return false
   try {
      await Order.updateOne({ _id: order._id }, { $set: { 'payment.lastAskedAt': new Date() } })
      const answer = await checkPaymentStatus(order.reference)
      if (!answer.paid) return false
      if (answer.transactionId) {
         await Order.updateOne(
            { _id: order._id },
            { $set: { 'payment.providerPaymentId': answer.transactionId } }
         )
      }
      await settle(order._id, 'PAID', 'SUCCESS (asked MaxiCash by reference)')
      return true
   } catch {
      return false
   }
}
