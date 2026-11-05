import { Types } from 'mongoose'
import { LISTING_STATUS, VERTICALS } from '../constants/domain.constants'
import { STARTER_ACCESSORIES, STARTER_SPECS, STARTER_TYPES } from '../constants/vehicleSale.defaults'
import { resolveLocalized, toLocalized } from '../model/shared.schema'
import {
   Parking,
   SaleVehicle,
   VEHICLE_AVAILABILITY,
   VehicleAccessory,
   VehicleSpec,
   VehicleType,
} from '../model/vehicleSaleModel'

/**
 * Vehicles for sale and the order pipeline. A vehicle is one of a kind, so it
 * is not a stock count: checkout RESERVES it for one order, cancelling that
 * order makes it AVAILABLE again, completing it makes it SOLD. Each move is
 * one conditional update naming the order, so a late cancel of one order can
 * never free a vehicle another order now holds.
 *
 * An order line names the parking as `listingId` and the vehicle as
 * `roomTypeId` — the slot a dish uses — with its `stockRef`.
 */

/** "Toyota Hilux 2018": what a vehicle is called when the office gave it no title. */
export const vehicleName = (v: { make?: string; model?: string; year?: number }) =>
   [v.make, v.model, v.year].filter(Boolean).join(' ')

/** One string for an order line or an e-mail: the French title, else make model year. */
export const vehicleLabel = (v: { title?: unknown; make?: string; model?: string; year?: number }) =>
   resolveLocalized(toLocalized(v.title), 'fr') || vehicleName(v)

/**
 * A vehicle is bought alone and one at a time: [message, code] when the
 * requested lines break that, null otherwise. Checked before anything is priced.
 */
export const vehicleSaleRefusal = (items: { vertical?: unknown; quantity?: unknown }[]): [string, string] | null => {
   const lines = items.filter((i) => i?.vertical === VERTICALS.VEHICLE_SALE)
   if (!lines.length) return null
   if (items.length !== 1) {
      return ['A vehicle is ordered on its own: one vehicle per order, with nothing else.', 'VEHICLE_ALONE']
   }
   if (Number(lines[0].quantity) !== 1) return ['A vehicle is ordered one at a time: the quantity must be 1.', 'VEHICLE_QUANTITY']
   return null
}

/** Takes the vehicle for this order; false when it is no longer available, having changed nothing. */
export const reserveVehicle = async (vehicleId: Types.ObjectId, orderId: Types.ObjectId) => {
   const res = await SaleVehicle.updateOne(
      { _id: vehicleId, status: LISTING_STATUS.PUBLISHED, availability: VEHICLE_AVAILABILITY.AVAILABLE },
      { $set: { availability: VEHICLE_AVAILABILITY.RESERVED, reservedOrder: orderId } }
   )
   return res.modifiedCount === 1
}

/** Back on sale — only while this order is the one holding it. */
export const releaseVehicle = (vehicleId: unknown, orderId: Types.ObjectId) =>
   SaleVehicle.updateOne(
      { _id: vehicleId, reservedOrder: orderId, availability: VEHICLE_AVAILABILITY.RESERVED },
      { $set: { availability: VEHICLE_AVAILABILITY.AVAILABLE }, $unset: { reservedOrder: 1 } }
   )

type OrderLike = { _id: Types.ObjectId; items?: { vertical?: string; roomTypeId?: unknown }[] }

const vehiclesOf = (order: OrderLike) =>
   (order.items ?? [])
      .filter((i) => i.vertical === VERTICALS.VEHICLE_SALE && i.roomTypeId)
      .map((i) => i.roomTypeId)

/** The order was cancelled (office, expiry job): its vehicle goes back on sale. */
export const releaseVehiclesOf = async (order: OrderLike) => {
   for (const id of vehiclesOf(order)) await releaseVehicle(id, order._id)
}

/** The order was completed (handed over): its vehicle is sold, out of the search for good. It keeps `reservedOrder`, the sale. */
export const sellVehiclesOf = async (order: OrderLike) => {
   for (const id of vehiclesOf(order)) {
      await SaleVehicle.updateOne(
         { _id: id, reservedOrder: order._id, availability: VEHICLE_AVAILABILITY.RESERVED },
         { $set: { availability: VEHICLE_AVAILABILITY.SOLD, soldAt: new Date() } }
      )
   }
}

/** Towns with a vehicle on sale now, for the catalogue facets. */
export const vehicleCities = async () => {
   const parkings = await SaleVehicle.distinct('parking', {
      status: LISTING_STATUS.PUBLISHED,
      availability: VEHICLE_AVAILABILITY.AVAILABLE,
   })
   const cities = await Parking.distinct('city', { _id: { $in: parkings }, status: LISTING_STATUS.PUBLISHED })
   return (cities as string[]).filter(Boolean).sort()
}

/** The common list (vehicleSale.defaults), where its slug or key is missing. Returns how many of each it added. */
export const addStarterCatalogue = async () => {
   const added = { types: 0, specs: 0, accessories: 0 }
   for (const [i, { slug, ...rest }] of STARTER_TYPES.entries()) {
      const r = await VehicleType.updateOne({ slug }, { $setOnInsert: { ...rest, sortOrder: i } }, { upsert: true })
      added.types += r.upsertedCount
   }
   for (const [i, { key, ...rest }] of STARTER_SPECS.entries()) {
      const r = await VehicleSpec.updateOne(
         { key },
         { $setOnInsert: { unit: '', choices: [], onCard: false, ...rest, sortOrder: i } },
         { upsert: true }
      )
      added.specs += r.upsertedCount
   }
   for (const [i, { key, ...rest }] of STARTER_ACCESSORIES.entries()) {
      const r = await VehicleAccessory.updateOne({ key }, { $setOnInsert: { ...rest, sortOrder: i } }, { upsert: true })
      added.accessories += r.upsertedCount
   }
   return added
}
