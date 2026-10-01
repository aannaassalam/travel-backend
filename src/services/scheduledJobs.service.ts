import cron from 'node-cron'

import { AUDIT_ACTIONS } from '../constants/admin.constants'
import {
   FULFILMENT_STATUS,
   LISTING_STATUS,
   ORDER_STATUS,
   PAYMENT_STATUS,
} from '../constants/domain.constants'
import { RatePlan } from '../model/hotelModel'
import { Listing } from '../model/listingModel'
import AuditLog from '../model/auditLogModel'
import { Customer } from '../model/customerModel.admin'
import { Order } from '../model/orderModel'
import { getSettings } from '../model/settingsModel'
import { sendOutOfBandAlert } from './auditLog.service'
import { NOTIFICATION_EVENTS } from '../model/enquiryModel'
import { notifyOrder } from './notifications/notify.service'

/** How long before a cash deadline the customer gets chased. */
const REMINDER_WINDOW_MS = 12 * 60 * 60 * 1000

/**
 * Background jobs. These are the parts of the guide that only work if something
 * runs without anyone clicking:
 *
 *   §6.1 / §15 — cash orders with no deadline, no auto-release and no
 *                reconciliation is listed explicitly as a thing to avoid.
 *   §14.5     — passport data purged N days after travel. Data no longer held
 *                cannot be leaked, and it is the cheapest control available.
 *   §5.1      — scheduled publish / unpublish.
 *   §14.2     — nightly inventory drift reconciliation, alerted out-of-band.
 *
 * ponytail: node-cron in-process, which is correct for one server. If the API
 * is ever run multi-instance these will each fire on every instance — move to a
 * single worker or add a database lock at that point.
 */

const systemAudit = async (action: string, detail: Record<string, any>) => {
   await AuditLog.create({
      actorEmail: 'system',
      action,
      entityType: 'ScheduledJob',
      after: detail,
      ip: 'internal',
      userAgent: 'cron',
   })
}

/**
 * §6.1: unpaid orders past their deadline release their stock and cancel.
 *
 * Covers BOTH rails: a cash order the customer never came in to settle, and an
 * online checkout abandoned at the payment step. Both hold stock the moment the
 * order is created, so both have to give it back.
 *
 * Releases `quantityHeld` / `held` — not `quantitySold`. Checkout takes a HOLD
 * and only payment converts it to a sale, so decrementing sold here would drive
 * it negative on every abandoned basket while leaving the hold stuck forever,
 * quietly removing the unit from sale for good.
 */
export const releaseExpiredCashHolds = async () => {
   const expired = await Order.find({
      // FAILED too: a declined payment keeps its hold for a retry, and if no
      // retry comes the stock has to return to sale like any other lapse.
      paymentStatus: {
         $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING, PAYMENT_STATUS.FAILED],
      },
      status: { $in: [ORDER_STATUS.DRAFT, ORDER_STATUS.SUBMITTED] },
      cashDeadline: { $lt: new Date() },
   }).limit(500)
   if (!expired.length) return 0

   for (const order of expired) {
      const heldIds = order.heldRatePlanIds ?? []
      for (const item of order.items) {
         if (item.roomTypeId && heldIds.length) {
            await RatePlan.updateMany(
               { _id: { $in: heldIds }, held: { $gte: item.quantity } },
               { $inc: { held: -item.quantity } }
            )
         } else if (item.listingId) {
            await Listing.updateOne(
               { _id: item.listingId, quantityHeld: { $gte: item.quantity } },
               { $inc: { quantityHeld: -item.quantity } }
            )
         }
      }
      const wasCash = order.paymentMethod === 'CASH'
      order.status = ORDER_STATUS.CANCELLED
      order.cancellationReason = 'CASH_DEADLINE_EXPIRED'
      order.cancelledAt = new Date()
      order.heldRatePlanIds = undefined
      order.timeline.push({
         at: new Date(),
         event: 'AUTO_CANCELLED',
         detail: wasCash
            ? 'Cash collection deadline passed — inventory released'
            : 'Payment not completed — inventory released',
         actorEmail: 'system',
      })
      await order.save()

      // §8: only a cash no-show is the customer's fault. An abandoned online
      // basket is not, and must not count against them.
      if (wasCash) {
         await Customer.updateOne({ _id: order.customer }, { $inc: { noShowCount: 1 } })
      }
   }

   await systemAudit('CASH_HOLDS_RELEASED', { count: expired.length })
   return expired.length
}

/**
 * §6.1: chase the cash before the deadline, not after it.
 *
 * Fires once per order, in the window before its deadline — `cashReminderSentAt`
 * is what stops a customer being texted every ten minutes for the last twelve
 * hours of their hold. An order that expires unchased is a sale lost to
 * silence, which is the whole reason the deadline is visible to the office.
 */
export const sendCashDeadlineReminders = async () => {
   const now = Date.now()
   const due = await Order.find({
      paymentMethod: 'CASH',
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING] },
      status: { $in: [ORDER_STATUS.DRAFT, ORDER_STATUS.SUBMITTED] },
      cashDeadline: {
         $gt: new Date(now),
         $lt: new Date(now + REMINDER_WINDOW_MS),
      },
      cashReminderSentAt: { $exists: false },
   }).limit(200)

   let sent = 0
   for (const order of due) {
      await Order.updateOne({ _id: order._id }, { $set: { cashReminderSentAt: new Date() } })
      sent += await notifyOrder(NOTIFICATION_EVENTS.CASH_DEADLINE_REMINDER, order._id)
   }
   if (sent) await systemAudit('CASH_REMINDERS_SENT', { count: sent })
   return sent
}

/** §14.5: purge document numbers N days after travel completes. */
export const purgePassportData = async () => {
   const settings = await getSettings()
   const cutoff = new Date(
      Date.now() - settings.passportRetentionDays * 86400000
   )
   const stale = await Order.find({
      travelDate: { $lt: cutoff },
      'travellers.documentNumber': { $exists: true, $ne: null },
   }).select('+travellers.documentNumber')

   let purged = 0
   for (const order of stale) {
      let touched = false
      order.travellers.forEach((t: any) => {
         if (t.documentNumber) {
            t.documentNumber = undefined
            t.documentPurgeAfter = undefined
            touched = true
         }
      })
      if (touched) {
         await order.save()
         purged += 1
      }
   }
   if (purged) {
      await systemAudit('PASSPORT_DATA_PURGED', {
         orders: purged,
         retentionDays: settings.passportRetentionDays,
      })
   }
   return purged
}

/** §5.1 scheduled publish / unpublish. */
export const applyScheduledPublishing = async () => {
   const now = new Date()
   const [published, unpublished] = await Promise.all([
      Listing.updateMany(
         { publishAt: { $lte: now }, status: LISTING_STATUS.DRAFT },
         { $set: { status: LISTING_STATUS.PUBLISHED }, $unset: { publishAt: 1 } }
      ),
      Listing.updateMany(
         { unpublishAt: { $lte: now }, status: LISTING_STATUS.PUBLISHED },
         { $set: { status: LISTING_STATUS.PAUSED }, $unset: { unpublishAt: 1 } }
      ),
   ])
   return { published: published.modifiedCount, unpublished: unpublished.modifiedCount }
}

/** Expire listings whose sell-by date has passed, so spoilage is truthful. */
export const expireStaleListings = async () => {
   const r = await Listing.updateMany(
      {
         validUntil: { $lt: new Date() },
         status: { $in: [LISTING_STATUS.PUBLISHED, LISTING_STATUS.DRAFT] },
      },
      { $set: { status: LISTING_STATUS.EXPIRED } }
   )
   return r.modifiedCount
}

/**
 * §14.2: inventory drift detected by the nightly reconciliation. Sold units
 * that exceed the allotment mean something oversold — the customer will arrive
 * at a hotel with no room, so this alerts rather than just logging.
 */
export const reconcileInventoryDrift = async () => {
   const oversoldNights = await RatePlan.find({
      $expr: { $gt: ['$sold', '$allotment'] },
   }).limit(50)
   const oversoldListings = await Listing.find({
      $expr: { $gt: ['$quantitySold', '$quantityTotal'] },
   }).limit(50)

   const total = oversoldNights.length + oversoldListings.length
   if (total) {
      await systemAudit('INVENTORY_DRIFT_DETECTED', {
         oversoldNights: oversoldNights.length,
         oversoldListings: oversoldListings.length,
      })
      await sendOutOfBandAlert(
         'INVENTORY_DRIFT_DETECTED',
         'system',
         `${total} oversold unit(s)`
      )
   }
   return total
}

/** §4.2: paid orders with no document 4 hours after payment escalate. */
export const flagUndocumentedOrders = async () => {
   const cutoff = new Date(Date.now() - 4 * 3600 * 1000)
   const r = await Order.updateMany(
      {
         paymentStatus: PAYMENT_STATUS.PAID,
         paidAt: { $lt: cutoff },
         fulfilmentStatus: FULFILMENT_STATUS.NOT_STARTED,
      },
      { $set: { fulfilmentStatus: FULFILMENT_STATUS.DOCUMENTS_PENDING } }
   )
   return r.modifiedCount
}

export const startScheduledJobs = () => {
   if (process.env.DISABLE_CRON === 'true') {
      console.log('Scheduled jobs disabled via DISABLE_CRON')
      return
   }

   // Every 10 minutes: the time-sensitive ones.
   cron.schedule('*/10 * * * *', async () => {
      try {
         await sendCashDeadlineReminders()
         await releaseExpiredCashHolds()
         await applyScheduledPublishing()
         await flagUndocumentedOrders()
      } catch (e: any) {
         console.error('Scheduled job (10m) failed:', e.message)
      }
   })

   // Nightly at 02:15: retention, expiry and reconciliation.
   cron.schedule('15 2 * * *', async () => {
      try {
         await purgePassportData()
         await expireStaleListings()
         await reconcileInventoryDrift()
      } catch (e: any) {
         console.error('Scheduled job (nightly) failed:', e.message)
      }
   })

   console.log('Scheduled jobs started (cash reminders + release, purge, publishing, reconciliation)')
}
