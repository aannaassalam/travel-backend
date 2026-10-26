import { Ride, RIDE_STATUS } from '../../model/rideModel'

/**
 * The ride behind an order, loaded for the public order DTO: with the driver's
 * public card and the vehicle, which the DTO shows from ASSIGNED on.
 */
const POPULATE = [
   { path: 'driver', select: 'name phone photo ratingStats' },
   { path: 'vehicle', select: 'make model color plate' },
]

const isTransfer = (order: { items?: { vertical?: string }[] }) =>
   (order.items ?? []).some((i) => i.vertical === 'TRANSFER')

export const rideOfOrder = async (order: { _id: unknown; items?: { vertical?: string }[] }) =>
   isTransfer(order) ? Ride.findOne({ order: order._id }).populate(POPULATE) : null

/**
 * Whether the order's ride was driven (under way or done): its fare is the
 * driver's to collect, not a hold for the cash-deadline job to release.
 */
export const rideDriven = async (order: { _id: unknown; items?: { vertical?: string }[] }) =>
   isTransfer(order) &&
   Boolean(
      await Ride.exists({ order: order._id, status: { $in: [RIDE_STATUS.STARTED, RIDE_STATUS.COMPLETED] } })
   )

/** Rides by order id, for a list of orders — one query, not one per booking. */
export const ridesOfOrders = async (orders: { _id: unknown; items?: { vertical?: string }[] }[]) => {
   const ids = orders.filter(isTransfer).map((o) => o._id)
   if (!ids.length) return new Map<string, any>()
   const rides = await Ride.find({ order: { $in: ids } }).populate(POPULATE)
   return new Map(rides.map((r) => [String(r.order), r]))
}
