import { NextFunction, Request, Response } from 'express'
import { isValidObjectId } from 'mongoose'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { CANCELLATION_REASONS } from '../../constants/domain.constants'
import { presentRideDetail, presentRideRow } from '../../dto/admin/transfer.dto'
import { Driver } from '../../model/driverModel'
import { Order } from '../../model/orderModel'
import { IRide, Ride, RIDE_STATUS } from '../../model/rideModel'
import { VehicleCategory } from '../../model/vehicleCategoryModel'
import { Vehicle } from '../../model/vehicleModel'
import { paginate } from '../../services/adminCrud.service'
import { recordAudit } from '../../services/auditLog.service'
import { driverBusyAround } from '../../services/transfers/availability'
import {
   assignRefusal,
   assignRide,
   cancelRideAndOrder,
   endRide,
   startRide,
   unassignRide,
} from '../../services/transfers/rideLifecycle'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'
import { escapeRx, sameName } from '../../utils/sameName'

/**
 * The rides board. Orders permissions: a ride is a booking the office runs —
 * assigning a driver, marking it started and ended for them, cancelling it
 * (and its order) when it falls through.
 */

const ENTITY = 'Ride'
const OPEN = new Set<string>([RIDE_STATUS.PENDING, RIDE_STATUS.ASSIGNED, RIDE_STATUS.STARTED])

const searchTerm = (v: unknown) => (typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, 80) : '')

/** "YYYY-MM-DD" or a full instant; a bare day bounds the whole day as rides store it (wall-clock). */
const dayStart = (v: unknown) => {
   const d = new Date(String(v ?? ''))
   return Number.isNaN(d.getTime()) ? null : d
}
const dayEnd = (v: unknown) => {
   const d = dayStart(v)
   if (!d) return null
   return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(d.getTime() + 86_400_000) : d
}

/** The bookings of a page of rides, for the payment chip. */
const ordersOf = async (rides: { order?: unknown }[]) => {
   const ids = rides.map((r) => r.order).filter(Boolean)
   const orders = ids.length
      ? await Order.find({ _id: { $in: ids } }).select('reference status paymentStatus paymentMethod').lean()
      : []
   return new Map(orders.map((o: any) => [String(o._id), o]))
}

/** GET /transfers/rides?status=&city=&driver=&from=&to=&q= */
export const listRides = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, any> = {}
   const city = searchTerm(req.query.city)
   if (city) filter.city = sameName(city)
   if (isValidObjectId(req.query.driver)) filter.driver = req.query.driver
   const from = dayStart(req.query.from)
   const to = dayEnd(req.query.to)
   if (from || to) filter.at = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) }
   const q = searchTerm(req.query.q)
   if (q) {
      const rx = new RegExp(escapeRx(q), 'i')
      filter.$or = [{ reference: rx }, { customerName: rx }, { customerPhone: rx }]
   }

   // The tabs count every status under the same filter, so a number on a tab
   // is the number of rows behind it. (aggregate() does not cast the filter
   // to the schema — a driver id would stay text and count nothing; find() does.)
   const grouped = await Ride.aggregate([
      { $match: Ride.find(filter).cast(Ride) },
      { $group: { _id: '$status', n: { $sum: 1 } } },
   ])
   const counts = Object.fromEntries(Object.values(RIDE_STATUS).map((s) => [s, 0])) as Record<string, number>
   for (const g of grouped) if (g._id in counts) counts[g._id] = g.n

   const status = String(req.query.status ?? '')
   if ((Object.values(RIDE_STATUS) as string[]).includes(status)) filter.status = status
   // What is coming, soonest first; what is over, latest first.
   const sort = OPEN.has(status) ? ({ at: 1, _id: 1 } as const) : ({ at: -1, _id: -1 } as const)
   const { items, ...paging } = await paginate<IRide>(Ride, filter, req, { sort: sort as any, populate: 'driver vehicle' })
   const orders = await ordersOf(items)
   return sendResponse(res, 200, 'OK', {
      items: items.map((r) => presentRideRow(r, orders.get(String(r.order)))),
      counts,
      ...paging,
   })
})

/** The ride with everything the page shows, and its booking with the customer. */
const rideDetail = async (id: string) => {
   if (!isValidObjectId(id)) throw new AppError('Ride not found', 404)
   const ride = await Ride.findById(id).populate('driver').populate('vehicle').populate('category', 'name seats')
   if (!ride) throw new AppError('Ride not found', 404)
   const order = ride.order ? await Order.findById(ride.order).populate('customer', 'firstName lastName phone email') : null
   return { ride, order }
}

/** `before`: the ride's `toObject()` snapshot from before the action, for the audit diff. */
const answer = async (req: Request, res: Response, message: string, before?: object) => {
   const { ride, order } = await rideDetail(req.params.id)
   if (before) {
      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: ENTITY,
         entityId: ride._id.toString(),
         before,
         after: ride.toObject(),
         reason: req.body?.reason ?? req.body?.note,
      })
   }
   return sendResponse(res, 200, message, { ride: presentRideDetail(ride, order) })
}

/** GET /transfers/rides/:id */
export const getRide = catchAsync(async (req: Request, res: Response) => answer(req, res, 'OK'))

const rideToAct = async (id: string) => {
   if (!isValidObjectId(id)) throw new AppError('Ride not found', 404)
   const ride = await Ride.findById(id)
   if (!ride) throw new AppError('Ride not found', 404)
   return ride
}

/**
 * POST /transfers/rides/:id/assign { driverId, vehicleId?, force? }
 *
 * A driver already holding a ride around that time is refused with the ride
 * in the way (409 DRIVER_BUSY) — the office can insist with `force`.
 */
export const assign = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const ride = await rideToAct(req.params.id)
   const { driverId, vehicleId, force } = req.body ?? {}
   if (!isValidObjectId(driverId)) return next(new AppError('Choose a driver', 400))
   const driver = await Driver.findById(driverId)
   if (!driver) return next(new AppError('Driver not found', 404))
   if (!driver.isActive) return next(new AppError('This driver is switched off', 409, 'DRIVER_INACTIVE'))

   // `||`: a form sends "" for "the driver's own car".
   const wantedVehicle = vehicleId || driver.vehicle
   if (!wantedVehicle || !isValidObjectId(wantedVehicle)) {
      return next(new AppError('This driver has no vehicle: pick one', 400, 'VEHICLE_REQUIRED'))
   }
   const vehicle = await Vehicle.findById(wantedVehicle)
   if (!vehicle) return next(new AppError('Vehicle not found', 404))
   if (!vehicle.isActive) return next(new AppError('This vehicle is switched off', 409, 'VEHICLE_INACTIVE'))
   // Another city, or a car too small for the party: refused, not forced.
   const category = await VehicleCategory.findById(vehicle.category).select('seats').lean()
   const unfit = assignRefusal(ride, driver, vehicle, category?.seats)
   if (unfit) return next(unfit)

   const busy = await driverBusyAround(driver._id, ride.at, ride.durationMinutes, ride._id)
   if (busy && force !== true) {
      // Answered directly: the conflicting ride has to reach the dialog, and the
      // error handler keeps `details` back in production.
      return res.status(409).json({
         status: 'fail',
         code: 'DRIVER_BUSY',
         message: `${driver.name} already has ride ${busy.reference ?? ''} around that time`,
         conflict: { reference: busy.reference, at: busy.at },
      })
   }
   const before = ride.toObject()
   await assignRide(ride, driver, vehicle, 'OFFICE', busy ? `${driver.name} · ${vehicle.plate} (forced over ${busy.reference})` : undefined)
   return answer(req, res, 'Driver assigned', before)
})

export const unassign = catchAsync(async (req: Request, res: Response) => {
   const ride = await rideToAct(req.params.id)
   const before = ride.toObject()
   await unassignRide(ride, 'OFFICE')
   return answer(req, res, 'Driver unassigned', before)
})

/** The office doing it for the driver — the timeline says so (actor OFFICE). */
export const start = catchAsync(async (req: Request, res: Response) => {
   const ride = await rideToAct(req.params.id)
   const before = ride.toObject()
   await startRide(ride, 'OFFICE')
   return answer(req, res, 'Ride started', before)
})

export const end = catchAsync(async (req: Request, res: Response) => {
   const ride = await rideToAct(req.params.id)
   const before = ride.toObject()
   await endRide(ride, 'OFFICE')
   return answer(req, res, 'Ride completed', before)
})

/** POST /transfers/rides/:id/cancel { reason, note? } — the ride and its booking, as the Bookings page cancels one. */
export const cancel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const ride = await rideToAct(req.params.id)
   const reason = String(req.body?.reason ?? '')
   if (!(reason in CANCELLATION_REASONS)) return next(new AppError('A valid cancellation reason code is required', 400))
   const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : undefined
   const before = ride.toObject()
   await cancelRideAndOrder(ride, reason, note, req)
   return answer(req, res, 'Ride cancelled', before)
})
