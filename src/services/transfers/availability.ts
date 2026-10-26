import { Types } from 'mongoose'
import { Driver } from '../../model/driverModel'
import { IRide, Ride, RIDE_STATUS } from '../../model/rideModel'
import { sameName } from '../../utils/sameName'

/**
 * Whether a driver is free for a ride. A driver with a ride at 10:00 is not
 * free at 10:30, nor at 09:30: each ride they hold blocks an hour either side
 * of it, for getting there and getting back.
 */

/** Travel time allowed before and after a ride, in ms. */
export const BUFFER_MS = 60 * 60_000

interface Timed {
   at: Date
   durationMinutes?: number
}

/** The time a held ride takes out of a driver's day. */
export const rideWindow = (ride: Timed) => {
   const start = new Date(ride.at).getTime()
   return {
      start: start - BUFFER_MS,
      end: start + (ride.durationMinutes ?? 0) * 60_000 + BUFFER_MS,
   }
}

/** Whether a ride the driver holds collides with one from `at` for `minutes`. */
export const conflicts = (held: Timed, at: Date, minutes: number) => {
   const w = rideWindow(held)
   const start = at.getTime()
   const end = start + Math.max(minutes, 0) * 60_000
   return w.start < end && start < w.end
}

const BLOCKING = [RIDE_STATUS.ASSIGNED, RIDE_STATUS.STARTED]
/** Rides more than two days either side cannot collide; the query stays small. */
const SPAN_MS = 2 * 86_400_000

const heldAround = (drivers: Types.ObjectId[], at: Date, minutes: number) =>
   Ride.find({
      driver: { $in: drivers },
      status: { $in: BLOCKING },
      at: { $gte: new Date(at.getTime() - SPAN_MS), $lte: new Date(at.getTime() + minutes * 60_000 + SPAN_MS) },
   })
      .select('reference at durationMinutes driver status')
      .lean()

/**
 * The ride that stops this driver taking one at `at`, or null. `except` is the
 * ride being assigned, which must not collide with itself.
 */
export const driverBusyAround = async (
   driverId: Types.ObjectId | string,
   at: Date,
   minutes: number,
   except?: Types.ObjectId | string
) => {
   const held = await heldAround([new Types.ObjectId(String(driverId))], at, minutes)
   return (
      (held.find((r) => String(r._id) !== String(except ?? '') && conflicts(r, at, minutes)) as
         | Pick<IRide, '_id' | 'reference' | 'at' | 'durationMinutes'>
         | undefined) ?? null
   )
}

export interface DriverAvailability {
   driver: any
   /** The reference of the ride in the way, when there is one. */
   busy?: string
   /** Out on a ride at this moment. */
   onRideNow: boolean
}

/**
 * The active drivers of a city who have a vehicle, each with whether they are
 * free at `at` — the office's assign dialog.
 */
export const availableDrivers = async (
   city: string,
   at: Date,
   minutes: number,
   except?: Types.ObjectId | string
): Promise<DriverAvailability[]> => {
   const drivers = await Driver.find({ city: sameName(city), isActive: true, vehicle: { $ne: null } })
      .populate('vehicle')
      .sort({ name: 1 })
      .limit(200)
   if (!drivers.length) return []
   const held = await heldAround(
      drivers.map((d) => d._id),
      at,
      minutes
   )
   const started = new Set(
      (await Ride.find({ driver: { $in: drivers.map((d) => d._id) }, status: RIDE_STATUS.STARTED }).select('driver').lean()).map(
         (r: any) => String(r.driver)
      )
   )
   return drivers.map((driver) => {
      const clash = held.find(
         (r: any) => String(r.driver) === String(driver._id) && String(r._id) !== String(except ?? '') && conflicts(r, at, minutes)
      )
      return { driver, busy: clash?.reference ?? (clash ? 'course' : undefined), onRideNow: started.has(String(driver._id)) }
   })
}
