import { NextFunction, Request, Response } from 'express'
import { presentDriverRide } from '../../dto/public/transfer.dto'
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../../middleware/customerAuth'
import {
   clearDriverCookie,
   currentDriver,
   DRIVER_SESSION_MS,
   setDriverCookie,
   signDriverToken,
} from '../../middleware/driverAuth'
import { Driver } from '../../model/driverModel'
import { Order } from '../../model/orderModel'
import { Ride, RIDE_STATUS } from '../../model/rideModel'
import { endRide, raiseAlert, startRide } from '../../services/transfers/rideLifecycle'
import { vehicleLabel } from '../../services/transfers/rideVars'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'
import { normalisePhone } from './customerAuthController'
import { jsonOnly, parseLocation } from './transferController'

/**
 * The driver portal's API. A driver signs in with the phone and the password
 * the office gave them, sees the rides assigned to them — today's, the coming
 * ones, the ones done — and marks each one started and ended.
 */

/** Today in Kinshasa as "YYYY-MM-DD". Rides are stored wall-clock, so this bounds `at` directly. */
export const kinshasaToday = (now = Date.now()) => new Date(now + 3600_000).toISOString().slice(0, 10)
const DAY_MS = 86_400_000
const DONE_WINDOW_MS = 30 * DAY_MS

const dayBounds = (day: string) => {
   const start = new Date(`${day}T00:00:00.000Z`)
   return { start, end: new Date(start.getTime() + DAY_MS) }
}

/** The rides of one driver for each tab of the portal. */
export const scopeFilter = (driverId: unknown, scope: string, now = Date.now()) => {
   const { end } = dayBounds(kinshasaToday(now))
   if (scope === 'upcoming') return { driver: driverId, status: RIDE_STATUS.ASSIGNED, at: { $gte: end } }
   if (scope === 'done') {
      return { driver: driverId, status: RIDE_STATUS.COMPLETED, at: { $gte: new Date(now - DONE_WINDOW_MS) } }
   }
   // Today: what is on, anything already under way whatever day it began, and
   // an assigned ride that is overdue — a 23:30 pick-up whose flight lands late
   // must still be there to start at 00:10, not fall between the tabs.
   return {
      driver: driverId,
      $or: [{ status: RIDE_STATUS.STARTED }, { status: RIDE_STATUS.ASSIGNED, at: { $lt: end } }],
   }
}

const presentMe = (d: any, counts?: { today: number; upcoming: number }) => ({
   id: d._id.toString(),
   name: d.name,
   phone: d.phone,
   city: d.city,
   photo: d.photo || undefined,
   vehicle:
      d.vehicle && typeof d.vehicle === 'object'
         ? {
              make: d.vehicle.make,
              model: d.vehicle.model,
              color: d.vehicle.color || undefined,
              plate: d.vehicle.plate,
              label: vehicleLabel(d.vehicle),
           }
         : undefined,
   ratingStats: d.ratingStats ?? { rating: 0, count: 0 },
   counts,
})

const session = (res: Response, driver: any, counts?: { today: number; upcoming: number }) => {
   const token = signDriverToken(driver._id.toString())
   setDriverCookie(res, token)
   return { token, expiresIn: DRIVER_SESSION_MS / 1000, driver: presentMe(driver, counts) }
}

/**
 * POST /driver/login { phone, password }. One error for every failure —
 * unknown number, wrong password, switched off — so the endpoint cannot be
 * used to learn who drives for the office.
 */
export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const phone = normalisePhone(req.body?.phone)
   const password = String(req.body?.password ?? '')
   if (!phone || !password) return next(new AppError('Phone number and password are required', 400))

   const driver = await Driver.findOne({ phone }).select('+password').populate('vehicle')
   // The compare runs whether or not the number is known or switched on, so
   // every refusal takes the same time (see verifyPassword).
   const ok = (await verifyPassword(password, driver?.password)) && driver?.isActive
   if (!ok) return next(new AppError('That phone number or password is not correct', 401, 'BAD_CREDENTIALS'))

   return sendResponse(res, 200, 'Signed in', session(res, driver))
})

export const logout = catchAsync(async (req: Request, res: Response) => {
   const driver = await currentDriver(req)
   // Tokens issued before now are refused, so a header-held token dies with the cookie.
   if (driver) await Driver.updateOne({ _id: driver._id }, { $set: { tokensValidFrom: new Date() } })
   clearDriverCookie(res)
   return sendResponse(res, 200, 'Signed out', {})
})

const counts = async (driverId: unknown) => {
   const [today, upcoming] = await Promise.all([
      Ride.countDocuments(scopeFilter(driverId, 'today')),
      Ride.countDocuments(scopeFilter(driverId, 'upcoming')),
   ])
   return { today, upcoming }
}

/** GET /driver/me */
export const me = catchAsync(async (req: Request, res: Response) => {
   const driver = (req as any).driver
   await driver.populate('vehicle')
   return sendResponse(res, 200, 'OK', { driver: presentMe(driver, await counts(driver._id)) })
})

/** PATCH /driver/me/password { current, next } — the session is re-issued so this phone stays signed in. */
export const changePassword = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const driver = await Driver.findById((req as any).driver._id).select('+password').populate('vehicle')
   if (!driver) return next(new AppError('Please sign in', 401))
   if (!(await verifyPassword(String(req.body?.current ?? ''), driver.password))) {
      return next(new AppError('The current password is not correct', 401, 'BAD_CREDENTIALS'))
   }
   const wanted = String(req.body?.next ?? '')
   if (wanted.length < MIN_PASSWORD_LENGTH) {
      return next(new AppError(`Your password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400, 'PASSWORD_WEAK'))
   }
   await Driver.updateOne(
      { _id: driver._id },
      // A second back, so the token issued just below (whole seconds) survives its own change.
      { $set: { password: await hashPassword(wanted), passwordChangedAt: new Date(Date.now() - 1000) } }
   )
   return sendResponse(res, 200, 'Password updated', session(res, driver))
})

/** The booking of each ride, for "paid" / "to collect". */
const ordersOf = async (rides: { order?: unknown }[]) => {
   const ids = rides.map((r) => r.order).filter(Boolean)
   const orders = ids.length
      ? await Order.find({ _id: { $in: ids } }).select('paymentMethod paymentStatus status').lean()
      : []
   return new Map(orders.map((o: any) => [String(o._id), o]))
}

/** GET /driver/rides?scope=today|upcoming|done */
export const listRides = catchAsync(async (req: Request, res: Response) => {
   const scope = ['today', 'upcoming', 'done'].includes(String(req.query.scope)) ? String(req.query.scope) : 'today'
   const rides = await Ride.find(scopeFilter((req as any).driver._id, scope))
      .sort({ at: scope === 'done' ? -1 : 1 })
      .limit(200)
   const orders = await ordersOf(rides)
   return sendResponse(res, 200, 'OK', {
      scope,
      items: rides.map((r) => presentDriverRide(r, orders.get(String(r.order)))),
   })
})

/** A driver can only act on rides assigned to them. */
const myRide = async (req: Request) => {
   const ride = await Ride.findOne({
      reference: String(req.params.reference ?? '').toUpperCase(),
      driver: (req as any).driver._id,
   })
   if (!ride) throw new AppError('Ride not found', 404)
   return ride
}

const answer = async (res: Response, message: string, ride: any) => {
   const orders = await ordersOf([ride])
   return sendResponse(res, 200, message, { ride: presentDriverRide(ride, orders.get(String(ride.order))) })
}

export const getRide = catchAsync(async (req: Request, res: Response) => answer(res, 'OK', await myRide(req)))

// The three actions are JSON-only (jsonOnly): the session cookie travels
// cross-site in production, and a form posted from another page must not be
// able to start or end a ride on the driver's behalf.
export const start = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!jsonOnly(req, next)) return
   return answer(res, 'Ride started', await startRide(await myRide(req), 'DRIVER'))
})

export const end = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!jsonOnly(req, next)) return
   return answer(res, 'Ride completed', await endRide(await myRide(req), 'DRIVER'))
})

/** POST /driver/rides/:reference/alert { lat?, lng?, note? } */
export const alert = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!jsonOnly(req, next)) return
   const ride = await myRide(req)
   const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : ''
   const { sent, officePhone } = await raiseAlert(ride, 'DRIVER', parseLocation(req.body), note)
   const orders = await ordersOf([ride])
   return sendResponse(res, 200, sent ? 'Alert sent to the office' : 'Alert recorded', {
      sent,
      officePhone: officePhone || undefined,
      ride: presentDriverRide(ride, orders.get(String(ride.order))),
   })
})
