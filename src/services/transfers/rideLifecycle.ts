import { Request } from 'express'
import { Types } from 'mongoose'
import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { ORDER_STATUS } from '../../constants/domain.constants'
import { IDriver, Driver } from '../../model/driverModel'
import { NOTIFICATION_EVENTS, NotificationLog, NotificationTemplate } from '../../model/enquiryModel'
import { Order } from '../../model/orderModel'
import { alertWindowOpen, IRide, Ride, RIDE_STATUS, RideActor } from '../../model/rideModel'
import { getSettings, ISettings } from '../../model/settingsModel'
import { IVehicle } from '../../model/vehicleModel'
import AppError from '../../utils/appError'
import { sameName } from '../../utils/sameName'
import { recordAudit } from '../auditLog.service'
import { notify, notifyOrder, orderLink, render } from '../notifications/notify.service'
import { sendSms, smsConfigured } from '../notifications/sms.service'
import { adminRideLink, driverPortalLink, rideVars } from './rideVars'

/**
 * How a ride moves: PENDING → ASSIGNED → STARTED → COMPLETED, or CANCELLED on
 * the way. Every step writes the ride's timeline and tells whoever needs to
 * know; the status checks live here so the office, the driver and the jobs
 * cannot each allow a different move.
 */

const push = (ride: IRide, event: string, actor: RideActor, detail?: string) =>
   ride.timeline.push({ at: new Date(), event, actor, detail })

const refuse = (message: string, code: string) => new AppError(message, 409, code)

/**
 * Tells a driver a ride is no longer theirs — cancelled, unassigned or given
 * to someone else — so nobody drives out to a pick-up for nothing. SMS only,
 * like DRIVER_RIDE_ASSIGNED (no `customer`, so never push). Not awaited by
 * the callers, so it never throws.
 */
const tellDriverRemoved = async (ride: IRide, driverId?: Types.ObjectId) => {
   try {
      const driver = driverId ? await Driver.findById(driverId).select('name phone') : null
      if (!driver?.phone) return
      await notify({
         event: NOTIFICATION_EVENTS.DRIVER_RIDE_REMOVED,
         recipient: driver.phone,
         order: ride.order,
         // Their ride list: the ride's own page is no longer theirs to open.
         vars: { ...rideVars(ride, driver), ride_link: driverPortalLink() },
      })
   } catch (err) {
      console.error(`[rides] could not tell the driver ${ride.reference} was taken off them:`, (err as Error).message)
   }
}

/**
 * Why this driver and car cannot take the ride, as a coded 409, or null: one
 * of them is based in another city, or the car has fewer seats than the party
 * (the car's own seat count when set, else its category's). Pure — the busy
 * check is availability's, and the only one the office may force.
 */
export const assignRefusal = (
   ride: Pick<IRide, 'city' | 'passengers'>,
   driver: Pick<IDriver, 'name' | 'city'>,
   vehicle: Pick<IVehicle, 'plate' | 'city' | 'seats'>,
   categorySeats?: number
) => {
   const elsewhere = (city: string) => !sameName(ride.city).test(city ?? '')
   if (elsewhere(driver.city)) return refuse(`${driver.name} is based in ${driver.city}, not ${ride.city}`, 'DRIVER_OTHER_CITY')
   if (elsewhere(vehicle.city)) return refuse(`${vehicle.plate} is in ${vehicle.city}, not ${ride.city}`, 'VEHICLE_OTHER_CITY')
   const seats = vehicle.seats ?? categorySeats
   if (seats && seats < ride.passengers) {
      return refuse(`${vehicle.plate} takes ${seats} passengers; this ride has ${ride.passengers}`, 'VEHICLE_TOO_SMALL')
   }
   return null
}

export const assignRide = async (
   ride: IRide,
   driver: IDriver,
   vehicle: IVehicle,
   actor: RideActor = 'OFFICE',
   detail?: string
) => {
   if (![RIDE_STATUS.PENDING, RIDE_STATUS.ASSIGNED].includes(ride.status as any)) {
      throw refuse('Only a ride that has not started can be assigned', 'RIDE_NOT_ASSIGNABLE')
   }
   // Given to another driver: the one who had it must not go.
   const previous =
      ride.status === RIDE_STATUS.ASSIGNED && ride.driver && !ride.driver.equals(driver._id) ? ride.driver : undefined
   ride.driver = driver._id
   ride.vehicle = vehicle._id
   ride.status = RIDE_STATUS.ASSIGNED
   ride.assignedAt = new Date()
   push(ride, 'RIDE_ASSIGNED', actor, detail ?? `${driver.name} · ${vehicle.plate}`)
   await ride.save()

   // The customer learns who is coming; the driver gets the ride's page.
   // Neither is awaited: a text that fails must not fail the assignment.
   if (ride.order) void notifyOrder(NOTIFICATION_EVENTS.TRANSFER_ASSIGNED, ride.order)
   const link = driverPortalLink(ride.reference)
   void notify({
      event: NOTIFICATION_EVENTS.DRIVER_RIDE_ASSIGNED,
      recipient: driver.phone,
      order: ride.order,
      vars: { ...rideVars(ride, driver, vehicle), ride_link: link },
      appendIfMissing: link ? { token: '{{ride_link}}', text: `\n${link}` } : undefined,
   })
   if (previous) void tellDriverRemoved(ride, previous)
   return ride
}

export const unassignRide = async (ride: IRide, actor: RideActor = 'OFFICE') => {
   if (ride.status !== RIDE_STATUS.ASSIGNED) throw refuse('Only an assigned ride can be unassigned', 'RIDE_NOT_ASSIGNED')
   const previous = ride.driver
   ride.driver = undefined
   ride.vehicle = undefined
   ride.assignedAt = undefined
   ride.status = RIDE_STATUS.PENDING
   push(ride, 'RIDE_UNASSIGNED', actor)
   await ride.save()
   void tellDriverRemoved(ride, previous)
   return ride
}

export const startRide = async (ride: IRide, actor: RideActor) => {
   if (ride.status !== RIDE_STATUS.ASSIGNED) throw refuse('The ride has to be assigned, and not yet started', 'RIDE_NOT_ASSIGNED')
   ride.status = RIDE_STATUS.STARTED
   ride.startedAt = new Date()
   push(ride, 'RIDE_STARTED', actor)
   await ride.save()
   if (ride.order) void notifyOrder(NOTIFICATION_EVENTS.TRANSFER_STARTED, ride.order)
   return ride
}

export const endRide = async (ride: IRide, actor: RideActor) => {
   if (ride.status !== RIDE_STATUS.STARTED) throw refuse('The ride has not started', 'RIDE_NOT_STARTED')
   ride.status = RIDE_STATUS.COMPLETED
   ride.endedAt = new Date()
   push(ride, 'RIDE_COMPLETED', actor)
   await ride.save()
   if (ride.order) void notifyOrder(NOTIFICATION_EVENTS.TRANSFER_COMPLETED, ride.order)
   return ride
}

/** The ride alone. The order is the caller's business (see below). */
export const cancelRide = async (ride: IRide, reason: string, actor: RideActor, detail?: string) => {
   if (ride.status === RIDE_STATUS.COMPLETED) throw refuse('A completed ride cannot be cancelled', 'RIDE_COMPLETED')
   if (ride.status === RIDE_STATUS.CANCELLED) return ride
   // A driver still to come is told not to; one already driving it is with the customer.
   const wasAssigned = ride.status === RIDE_STATUS.ASSIGNED
   ride.status = RIDE_STATUS.CANCELLED
   ride.cancelledAt = new Date()
   ride.cancellationReason = reason
   push(ride, 'RIDE_CANCELLED', actor, detail)
   await ride.save()
   if (wasAssigned) void tellDriverRemoved(ride, ride.driver)
   return ride
}

/**
 * The hook for the two places an ORDER is cancelled — the office from the
 * booking page, and the cash-deadline job: the ride goes with it. Never
 * throws; a ride that cannot be found or is already over is left alone.
 */
export const cancelRideOfOrder = async (orderId: Types.ObjectId, reason: string, actor: RideActor, detail?: string) => {
   try {
      const ride = await Ride.findOne({ order: orderId })
      if (!ride || ride.status === RIDE_STATUS.COMPLETED || ride.status === RIDE_STATUS.CANCELLED) return null
      return await cancelRide(ride, reason, actor, detail)
   } catch (err) {
      console.error(`[rides] could not cancel the ride of order ${orderId}:`, (err as Error).message)
      return null
   }
}

/**
 * The office cancelling from the ride: the ride, then its order the way the
 * Bookings page cancels one — status, timeline, the ORDER_CANCELLED text to
 * the customer, an audit entry. Nothing to release: a ride holds no stock.
 */
export const cancelRideAndOrder = async (ride: IRide, reason: string, note: string | undefined, req: Request) => {
   const order = ride.order ? await Order.findById(ride.order) : null
   if (order?.status === ORDER_STATUS.COMPLETED) throw refuse('A completed booking cannot be cancelled', 'ORDER_COMPLETED')
   await cancelRide(ride, reason, 'OFFICE', note)
   if (!order || order.status === ORDER_STATUS.CANCELLED) return ride

   const before = order.toObject()
   order.status = ORDER_STATUS.CANCELLED
   order.cancellationReason = reason
   order.cancelledAt = new Date()
   order.timeline.push({
      at: new Date(),
      event: 'STATUS_CANCELLED',
      detail: 'Ride cancelled',
      reason: note || reason,
      actorEmail: (req as any).admin?.email,
   })
   await order.save()
   void notifyOrder(NOTIFICATION_EVENTS.ORDER_CANCELLED, order._id)
   await recordAudit(req, {
      action: AUDIT_ACTIONS.UPDATE,
      entityType: 'Order',
      entityId: order._id.toString(),
      before,
      after: order.toObject(),
      reason: note || reason,
   })
   return ride
}

/** The driver's rating, recounted from every rated ride so a missed call cannot make it drift. */
export const refreshDriverRating = async (driver: Types.ObjectId | { _id: Types.ObjectId }) => {
   // The id itself: a ride read with its driver populated hands the document,
   // and aggregate() does not cast a document down to its id (find() would) —
   // the match would find no ride and write 0/0 over the driver's stats.
   const driverId = new Types.ObjectId(String((driver as { _id?: Types.ObjectId })._id ?? driver))
   const [row] = await Ride.aggregate([
      { $match: { driver: driverId, 'rating.score': { $exists: true } } },
      { $group: { _id: null, rating: { $avg: '$rating.score' }, count: { $sum: 1 } } },
   ])
   const ratingStats = { rating: row ? Math.round(row.rating * 10) / 10 : 0, count: row?.count ?? 0 }
   await Driver.updateOne({ _id: driverId }, { $set: { ratingStats } }, { timestamps: false })
   return ratingStats
}

export const MAX_RATING_COMMENT = 500

export const rateRide = async (ride: IRide, score: number, comment?: string) => {
   if (!Number.isInteger(score) || score < 1 || score > 5) throw new AppError('Choose from 1 to 5 stars', 400, 'INVALID_RATING')
   if (ride.status !== RIDE_STATUS.COMPLETED) throw refuse('The ride can be rated once it is over', 'RIDE_NOT_COMPLETED')
   if (ride.rating) throw refuse('This ride has already been rated', 'ALREADY_RATED')
   const text = String(comment ?? '').trim().slice(0, MAX_RATING_COMMENT)
   ride.rating = { score, comment: text || undefined, at: new Date() }
   push(ride, 'RIDE_RATED', 'CUSTOMER', `${score}/5`)
   await ride.save()
   if (ride.driver) await refreshDriverRating(ride.driver as Types.ObjectId)
   return ride
}

// ---------------------------------------------------------------- security alerts

/** Where an alert is texted: the alert phone, else the primary office, else support. */
export const alertPhone = (settings: Pick<ISettings, 'transferAlertPhone' | 'offices' | 'supportPhone'>) =>
   settings.transferAlertPhone ||
   (settings.offices ?? []).find((o) => o.isPrimary)?.phone ||
   (settings.offices ?? [])[0]?.phone ||
   settings.supportPhone ||
   ''

/**
 * SAFETY RULE: sent even when nobody has written a template for it. An alert
 * must never depend on configuration someone may have switched off.
 */
export const DEFAULT_ALERT_BODY =
   'ALERTE SÉCURITÉ course {{order_ref}} par {{alert_by}}. Chauffeur {{driver_name}} {{driver_phone}}, client {{customer_name}} {{customer_phone}}. Position : {{alert_location}}. {{ride_link}}'

export const mapsLink = (location?: { lat: number; lng: number } | null) =>
   location ? `https://maps.google.com/?q=${location.lat},${location.lng}` : 'non partagée'

const sendDefaultAlert = async (phone: string, body: string, order?: Types.ObjectId) => {
   const log = { event: NOTIFICATION_EVENTS.TRANSFER_ALERT, channel: 'SMS', recipient: phone, order, body }
   try {
      if (!smsConfigured()) {
         await NotificationLog.create({ ...log, status: 'FAILED', providerMessage: 'SMS provider is not configured' })
         return 0
      }
      const result = await sendSms(phone, body)
      await NotificationLog.create({ ...log, status: 'SENT', providerMessage: `${result.sid} (${result.status})`, costMinor: result.costMinor })
      return 1
   } catch (err) {
      await NotificationLog.create({ ...log, status: 'FAILED', providerMessage: (err as Error).message.slice(0, 300) })
      return 0
   }
}

/**
 * A security alert from the customer or the driver: recorded on the ride and
 * texted to the office, with a map link when a position came with it. The
 * office calls back — nobody else is texted.
 */
export const raiseAlert = async (
   ride: IRide,
   by: 'CUSTOMER' | 'DRIVER',
   location?: { lat: number; lng: number } | null,
   note?: string
) => {
   if (!alertWindowOpen(ride)) {
      throw refuse('A security alert can be sent from the moment a driver is assigned until two hours after the ride', 'ALERT_WINDOW_CLOSED')
   }
   if (!ride.populated('driver')) await ride.populate('driver vehicle')
   const settings = await getSettings()
   const phone = alertPhone(settings)
   const vars = {
      ...rideVars(ride, ride.driver as any, ride.vehicle as any),
      alert_by: by === 'DRIVER' ? 'le chauffeur' : 'le client',
      alert_location: mapsLink(location),
      ride_link: adminRideLink(ride._id) || (ride.reference ? orderLink(ride.reference) : ''),
   }

   let sent = 0
   if (!phone) {
      await NotificationLog.create({
         event: NOTIFICATION_EVENTS.TRANSFER_ALERT,
         channel: 'SMS',
         recipient: 'office',
         order: ride.order,
         status: 'FAILED',
         body: render(DEFAULT_ALERT_BODY, vars),
         providerMessage: 'No office phone set for alerts (Settings → Transfers, or the primary office)',
      })
   } else if (
      // The SMS template specifically: the office is reached by text, so an
      // active push-only template must not count as "configured" and leave the
      // alert unsent.
      await NotificationTemplate.exists({ event: NOTIFICATION_EVENTS.TRANSFER_ALERT, channel: 'SMS', isActive: true })
   ) {
      sent = await notify({ event: NOTIFICATION_EVENTS.TRANSFER_ALERT, recipient: phone, vars, order: ride.order })
   } else {
      sent = await sendDefaultAlert(phone, render(DEFAULT_ALERT_BODY, vars), ride.order)
   }

   ride.alerts.push({
      at: new Date(),
      by,
      lat: location?.lat,
      lng: location?.lng,
      note: String(note ?? '').trim().slice(0, 300) || undefined,
      smsSent: sent > 0,
   })
   push(ride, 'ALERT_RAISED', by, note ? String(note).slice(0, 300) : undefined)
   await ride.save()
   return { sent: sent > 0, officePhone: phone }
}
