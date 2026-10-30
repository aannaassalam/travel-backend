import cron from 'node-cron'

import { AUDIT_ACTIONS } from '../constants/admin.constants'
import {
   FULFILMENT_STATUS,
   LEGACY_INACTIVE_STATUSES,
   LISTING_STATUS,
   ORDER_STATUS,
   PAYMENT_STATUS,
   VERTICALS,
} from '../constants/domain.constants'
import { Hotel, RatePlan, RoomType } from '../model/hotelModel'
import { Listing } from '../model/listingModel'
import { Supplier } from '../model/supplierModel'
import { MenuItem, Restaurant } from '../model/restaurantModel'
import AuditLog from '../model/auditLogModel'
import { Customer } from '../model/customerModel.admin'
import { Order } from '../model/orderModel'
import { getSettings } from '../model/settingsModel'
import { sendOutOfBandAlert } from './auditLog.service'
import { NOTIFICATION_TEMPLATE_DEFAULTS } from '../constants/notificationTemplates.defaults'
import { NOTIFICATION_EVENTS, NotificationTemplate } from '../model/enquiryModel'
import { notifyOrder } from './notifications/notify.service'
import { askMaxicash } from './payments/settlement.service'
import { cancelRideOfOrder } from './transfers/rideLifecycle'
import { rideDriven } from './transfers/rideLookup'

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

export const systemAudit = async (action: string, detail: Record<string, any>) => {
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
      /**
       * A payment was opened at MaxiCash for this booking: before letting it
       * go, ask MaxiCash whether it was paid. A notice that never arrived must
       * not cost a customer who paid their seat.
       */
      if (await askMaxicash(order as any)) continue

      /**
       * A ride that was driven is paid to the driver, not at a counter (its
       * deadline sits a day past the pick-up, see cashDeadlineFor): the
       * booking is not cancelled because the office has not recorded the cash
       * yet. The deadline is dropped so the job stops looking at it; the
       * office settles it from the booking.
       */
      if (await rideDriven(order)) {
         order.cashDeadline = undefined
         order.timeline.push({
            at: new Date(),
            event: 'CASH_DEADLINE_WAIVED',
            detail: 'Ride driven — the fare is collected by the driver',
            actorEmail: 'system',
         })
         await order.save()
         continue
      }

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
      // A transfer's ride lapses with its unpaid booking.
      await cancelRideOfOrder(order._id, 'CASH_DEADLINE_EXPIRED', 'SYSTEM', 'Booking not paid in time')

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
 * is what stops a customer being messaged every ten minutes for the last twelve
 * hours of their hold. An order that expires unchased is a sale lost to
 * silence, which is the whole reason the deadline is visible to the office.
 */
export const sendCashDeadlineReminders = async () => {
   const now = Date.now()
   const due = await Order.find({
      paymentMethod: 'CASH',
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING] },
      status: { $in: [ORDER_STATUS.DRAFT, ORDER_STATUS.SUBMITTED] },
      // Not a ride: its deadline is a day past the pick-up, so "due by" would
      // reach the customer after the ride — and they pay the driver, not us.
      'items.vertical': { $ne: VERTICALS.TRANSFER },
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

/**
 * DRAFT and PAUSED became one status, INACTIVE. Records written before that
 * still carry the old words, and the schema enum no longer lists them — so the
 * next edit to one would fail validation on a field nobody touched.
 *
 * Run on every boot rather than as a migration someone has to remember: it is
 * five indexed updates that match nothing after the first time.
 *
 * Room types are the exception. They never had a publish step — the panel
 * always sent them as live and a hardening change began dropping that — so a
 * leftover one is a room the office believed was on sale. It goes to PUBLISHED;
 * its hotel's own status still decides whether a customer can see it.
 */
export const normaliseLegacyStatuses = async () => {
   const legacy = { status: { $in: [...LEGACY_INACTIVE_STATUSES] } }
   const inactive = { $set: { status: LISTING_STATUS.INACTIVE } }
   const [hotels, restaurants, listings, dishes, rooms] = await Promise.all([
      Hotel.updateMany(legacy, inactive),
      Restaurant.updateMany(legacy, inactive),
      Listing.updateMany(legacy, inactive),
      MenuItem.updateMany(legacy, inactive),
      RoomType.updateMany(legacy, { $set: { status: LISTING_STATUS.PUBLISHED } }),
   ])
   const changed = {
      hotels: hotels.modifiedCount,
      restaurants: restaurants.modifiedCount,
      listings: listings.modifiedCount,
      menuItems: dishes.modifiedCount,
      roomTypes: rooms.modifiedCount,
   }
   if (Object.values(changed).some(Boolean)) {
      console.log('Inventory statuses normalised to INACTIVE/PUBLISHED:', JSON.stringify(changed))
      await systemAudit('INVENTORY_STATUS_NORMALISED', changed)
   }
   return changed
}

/**
 * The catalogue as it was before suppliers, room prices and route timetables,
 * brought up to date. Run on every boot like the status rewrite above: three
 * queries that find nothing after the first time.
 *
 * - A supplier typed as text on a hotel or listing becomes a Supplier record
 *   (one per name, whatever its case) that the record then points at.
 * - A room type with no price of its own takes the one its old nightly
 *   calendar had for tonight, or the next night priced — or failing that the
 *   last one. A room with no price at all stays unbookable until one is set.
 * - A bus or flight that was one dated departure, with no timetable, cannot
 *   be booked any more: it is taken off the website (INACTIVE) until the
 *   office gives it its agency, destination and times.
 * - A car with a supplier but no operator name — saved before a car showed
 *   its rental company — takes its supplier's name, as a save now gives it.
 */
const escapeRx = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A sell price still in dollars, as a query: a USD figure, or a bare number
 * (older still, before prices had currencies: cents too). This code always
 * writes a price whole, as francs only.
 */
const IN_DOLLARS = [{ 'sellPrice.USD': { $type: 'number' } }, { sellPrice: { $type: 'number' } }]

export const migrateCatalogueModel = async () => {
   const changed = {
      suppliersCreated: 0,
      supplierLinks: 0,
      roomPrices: 0,
      routesTakenDown: 0,
      carOperators: 0,
   }

   for (const model of [Hotel, Listing] as any[]) {
      // The raw collection: the schema now says ObjectId, and casting the old
      // text would fail before it could be read.
      const rows = await model.collection
         .find({ supplier: { $type: 'string' } })
         .project({ supplier: 1 })
         .toArray()
      for (const row of rows) {
         const name = String(row.supplier).trim()
         if (!name) {
            await model.collection.updateOne({ _id: row._id }, { $unset: { supplier: '' } })
            continue
         }
         let supplier = await Supplier.findOne({ name: new RegExp(`^${escapeRx(name)}$`, 'i') })
         if (!supplier) {
            supplier = await Supplier.create({ name })
            changed.suppliersCreated += 1
         }
         await model.collection.updateOne({ _id: row._id }, { $set: { supplier: supplier._id } })
         changed.supplierLinks += 1
      }
   }

   // In francs. A room or a night still in dollars (migrate:cdf not yet run) is
   // left alone: a franc figure next to its dollars dates from before
   // conversion, and copying it would replace the room's real price (and its
   // cost with 0).
   const today = new Date(new Date().toISOString().slice(0, 10))
   const unpriced = await RoomType.collection
      .find({
         $nor: IN_DOLLARS,
         $or: [{ 'sellPrice.CDF': { $exists: false } }, { 'sellPrice.CDF': { $lte: 0 } }],
      })
      .project({ _id: 1 })
      .toArray()
   // One read and one write, whatever the count: two look-ups per room were
   // 48 s of silence at boot on 2026-10-26 (63 rooms, 300 ms to the database).
   const nights = unpriced.length
      ? await RatePlan.collection
           .find({ roomType: { $in: unpriced.map((r) => r._id) }, 'sellPrice.CDF': { $gt: 0 }, $nor: IN_DOLLARS })
           .project({ roomType: 1, date: 1, sellPrice: 1, costPrice: 1, mealPlan: 1 })
           .sort({ date: 1 })
           .toArray()
      : []
   // Per room: its first night from today on, else its last one.
   const plans = new Map<string, any>()
   for (const night of nights) {
      const had = plans.get(String(night.roomType))
      if (!had || had.date < today) plans.set(String(night.roomType), night)
   }
   if (plans.size) {
      await RoomType.collection.bulkWrite(
         [...plans.values()].map((plan) => ({
            updateOne: {
               filter: { _id: plan.roomType },
               update: {
                  $set: {
                     sellPrice: { CDF: plan.sellPrice.CDF },
                     costPrice: { CDF: plan.costPrice?.CDF ?? 0 },
                     mealPlan: plan.mealPlan ?? 'ROOM_ONLY',
                  },
               },
            },
         })),
         { ordered: false }
      )
      changed.roomPrices += plans.size
   }

   const down = await Listing.updateMany(
      {
         vertical: { $in: [VERTICALS.BUS, VERTICALS.FLIGHT] },
         status: { $in: [LISTING_STATUS.PUBLISHED, LISTING_STATUS.SOLD_OUT] },
         'attributes.dailyTimes.0': { $exists: false },
         'attributes.weeklyTimes.0': { $exists: false },
      },
      { $set: { status: LISTING_STATUS.INACTIVE }, $inc: { __v: 1 } }
   )
   changed.routesTakenDown = down.modifiedCount

   const unnamed = {
      vertical: VERTICALS.CAR,
      supplier: { $ne: null },
      'attributes.operator': { $in: [null, ''] },
   }
   for (const id of await Listing.distinct('supplier', unnamed)) {
      // A supplier since deleted names nothing: the car is left as it is.
      const name = (await Supplier.findById(id).select('name'))?.name
      if (!name) continue
      const named = await Listing.updateMany(
         { ...unnamed, supplier: id },
         { $set: { 'attributes.operator': name }, $inc: { __v: 1 } }
      )
      changed.carOperators += named.modifiedCount
   }

   if (Object.values(changed).some(Boolean)) {
      console.log('Catalogue brought up to date:', JSON.stringify(changed))
      await systemAudit('CATALOGUE_MODEL_MIGRATED', changed)
   }
   return changed
}

/**
 * An event with no SMS template sends nothing, and the seed that writes them
 * replaces every SMS template — the office's wording with it — so it is not
 * run on a live database. Instead each boot adds the default of every event
 * with no SMS template at all, and touches nothing else: an edited one keeps
 * its words, one the office switched off stays off.
 */
export const ensureDefaultTemplates = async () => {
   const have = new Set(await NotificationTemplate.distinct('event', { channel: 'SMS' }))
   // One the office deleted stays deleted: the admin's delete promises no SMS
   // for that event until a template is saved again. Its delete is audited.
   const deleted = new Set(
      await AuditLog.distinct('before.event', {
         action: AUDIT_ACTIONS.PURGE,
         entityType: 'NotificationTemplate',
         'before.channel': 'SMS',
      })
   )
   const missing = NOTIFICATION_TEMPLATE_DEFAULTS.filter((t) => !have.has(t.event) && !deleted.has(t.event))
   if (!missing.length) return 0
   await NotificationTemplate.insertMany(missing.map((t) => ({ ...t, channel: 'SMS', isActive: true })))
   const events = missing.map((t) => t.event)
   console.log(`${events.length} notification template(s) added: ${events.join(', ')}`)
   await systemAudit('NOTIFICATION_TEMPLATES_ADDED', { count: events.length, events })
   return events.length
}

/**
 * Prices were dollars until 2026-10-24 and are francs now; scripts/migrateCdfBase
 * converts them, once, by hand. Until it has run, each price still in dollars
 * reads as unpriced — so every boot says so, loudly. Never fatal.
 */
export const warnDollarPrices = async () => {
   const counts = await Promise.all(
      [Listing, RoomType, MenuItem].map((m: any) => m.collection.countDocuments({ $or: IN_DOLLARS }))
   )
   const n = counts.reduce((a, b) => a + b, 0)
   if (n) {
      console.warn(
         `⚠️  ${n} prices are still in dollars — run npm run migrate:cdf -- --rate=<francs per USD> --apply`
      )
   }
   return n
}

/**
 * §5.1 scheduled publish / unpublish.
 *
 * In three steps, in this order, so that a window the job arrives late for
 * still ends the way its dates asked.
 */
export const applyScheduledPublishing = async () => {
   const now = new Date()
   const due = { $lte: now }
   const { PUBLISHED, INACTIVE } = LISTING_STATUS
   // Each date does its work once and is then cleared. One left behind acts
   // again later: a passed "publish at" brings a listing back ten minutes after
   // a take-down, a passed "unpublish at" takes it down ten minutes after its
   // next publication.

   // 1. Both dates passed, the take-down last: the window is over, so the
   //    publish date has nothing left to do. (The other order — "down at
   //    22:00, up again at 23:00" — is a way back, and step 3 honours it.)
   await Listing.updateMany(
      {
         status: { $in: [PUBLISHED, INACTIVE] },
         publishAt: due,
         unpublishAt: due,
         $expr: { $gte: ['$unpublishAt', '$publishAt'] },
      },
      { $unset: { publishAt: 1 } }
   )
   // 2. Take down what is due; on something already off sale the date is spent.
   const unpublished = await Listing.updateMany(
      { unpublishAt: due, status: PUBLISHED },
      { $set: { status: INACTIVE }, $unset: { unpublishAt: 1 } }
   )
   await Listing.updateMany({ unpublishAt: due, status: INACTIVE }, { $unset: { unpublishAt: 1 } })
   // 3. Put on sale what is due — one at a time, and only what the Publish
   //    button itself would accept. A listing with no photo, no cost price or
   //    a flight with no times stays inactive and is looked at again next run.
   //    On something already on sale the date is spent.
   await Listing.updateMany({ publishAt: due, status: PUBLISHED }, { $unset: { publishAt: 1 } })
   let published = 0
   for (const listing of await Listing.find({ publishAt: due, status: INACTIVE })) {
      // One record that cannot be read must not keep the rest off sale.
      try {
         if (listing.publishBlockers().length) continue
         const r = await Listing.updateOne(
            { _id: listing._id, status: INACTIVE },
            { $set: { status: PUBLISHED }, $unset: { publishAt: 1 } }
         )
         published += r.modifiedCount
      } catch (e: any) {
         console.error(`Scheduled publishing skipped listing ${listing._id}:`, e.message)
      }
   }
   return { published, unpublished: unpublished.modifiedCount }
}

/**
 * Expire what can no longer be sold, so spoilage is truthful: a flight or bus
 * once it has departed, and anything still carrying an old sell-by date (the
 * panel no longer sets one; records from before keep theirs).
 */
export const expireStaleListings = async () => {
   const now = new Date()
   const r = await Listing.updateMany(
      {
         $or: [
            { validUntil: { $lt: now } },
            { 'attributes.departsAt': { $lt: now } },
            // A flight entered before departures were mirrored onto the listing
            // keeps its time on the first leg only. Read exactly as
            // `publishBlockers` reads it, so the two can never disagree about
            // whether something has left.
            {
               'attributes.departsAt': null,
               'attributes.segments.0.departsAt': { $lt: now },
            },
         ],
         status: { $in: [LISTING_STATUS.PUBLISHED, LISTING_STATUS.INACTIVE] },
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
      // Here rather than nightly, and in a try of its own: a flight that left
      // at 08:00 was on sale until 02:15 the next morning, and a failure in
      // any job above must not keep it there.
      try {
         await expireStaleListings()
      } catch (e: any) {
         console.error('Scheduled job (expiry) failed:', e.message)
      }
   })

   // Nightly at 02:15: retention and reconciliation.
   cron.schedule('15 2 * * *', async () => {
      try {
         await purgePassportData()
         await reconcileInventoryDrift()
      } catch (e: any) {
         console.error('Scheduled job (nightly) failed:', e.message)
      }
   })

   console.log('Scheduled jobs started (cash reminders + release, purge, publishing, expiry, reconciliation)')
}
