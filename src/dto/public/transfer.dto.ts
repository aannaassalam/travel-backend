import { alertWindowOpen, RIDE_STATUS } from '../../model/rideModel'
import { Localized } from '../../model/shared.schema'
import { inAllCurrencies } from '../../services/fx.service'

/**
 * Public transfer DTOs: what a customer, or the driver on their portal, is
 * shown. §14.3 rule 2: nothing shared with src/dto/admin.
 *
 * Absent on purpose and permanently: a category's `costPerKm`/`costPerHour`,
 * a ride's `cost`, the driver's password hash and licence, the customer's id
 * and e-mail on the driver's side, and the driver's phone before a driver is
 * actually assigned.
 */

/** Only the locales that actually have text — blanks are noise on the wire. */
const localized = (value: Localized | string | undefined) => {
   if (!value) return {}
   if (typeof value === 'string') return { fr: value }
   return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string' && v.trim()))
}

const iso = (d?: Date | string | null) => (d ? new Date(d).toISOString() : undefined)

export const presentPublicCategory = (c: any) => ({
   id: c._id.toString(),
   name: localized(c.name),
   description: localized(c.description),
   image: c.image || undefined,
   seats: c.seats,
   luggage: c.luggage || undefined,
   // `{ CDF: 0 }` for a mode the category does not sell; the quote lists only priced ones.
   pricePerKm: inAllCurrencies(c.pricePerKm),
   pricePerHour: inAllCurrencies(c.pricePerHour),
   minimumFare: inAllCurrencies(c.minimumFare),
})

export const presentPublicPlace = (p: any) => ({
   id: p._id.toString(),
   name: localized(p.name),
   kind: p.kind,
   lat: p.lat,
   lng: p.lng,
})

const point = (p: any) =>
   p ? { label: p.label, lat: p.lat, lng: p.lng, placeId: p.placeId ? String(p.placeId) : undefined } : undefined

/** From when a driver is on the ride, the customer may know who. */
const DRIVER_SHOWN = new Set<string>([RIDE_STATUS.ASSIGNED, RIDE_STATUS.STARTED, RIDE_STATUS.COMPLETED])
const populated = (v: any) => v && typeof v === 'object' && !(v instanceof Date) && v._id !== undefined

const rideCore = (r: any) => ({
   status: r.status,
   mode: r.mode,
   city: r.city,
   pickup: point(r.pickup),
   dropoff: point(r.dropoff),
   at: iso(r.at),
   hours: r.hours ?? undefined,
   passengers: r.passengers,
   distanceKm: r.distanceKm,
   durationMinutes: r.durationMinutes,
   routeSource: r.routeSource,
   route: r.route ?? undefined,
   category: r.categoryName,
   notes: r.notes || undefined,
   startedAt: iso(r.startedAt),
   endedAt: iso(r.endedAt),
   alertsCount: r.alerts?.length ?? 0,
   canAlert: alertWindowOpen(r),
})

/** The customer's view, inside their order. */
export const presentPublicRide = (r: any) => ({
   ...rideCore(r),
   driver:
      DRIVER_SHOWN.has(r.status) && populated(r.driver)
         ? {
              name: r.driver.name,
              phone: r.driver.phone,
              photo: r.driver.photo || undefined,
              rating: r.driver.ratingStats?.rating ?? 0,
              count: r.driver.ratingStats?.count ?? 0,
           }
         : undefined,
   vehicle:
      DRIVER_SHOWN.has(r.status) && populated(r.vehicle)
         ? { make: r.vehicle.make, model: r.vehicle.model, color: r.vehicle.color || undefined, plate: r.vehicle.plate }
         : undefined,
   rating: r.rating ? { score: r.rating.score, comment: r.rating.comment || undefined, at: iso(r.rating.at) } : undefined,
   canRate: r.status === RIDE_STATUS.COMPLETED && !r.rating,
})

/**
 * The driver's view. The customer's name and number (they have to meet and
 * call), and what the customer pays — the driver collects it when the order is
 * cash — but never the customer's account, nor what the ride costs the office.
 */
export const presentDriverRide = (r: any, order?: any) => ({
   id: r._id?.toString(),
   reference: r.reference,
   ...rideCore(r),
   customer: { name: r.customerName, phone: r.customerPhone },
   price: inAllCurrencies(r.price),
   payment: order
      ? {
           method: order.paymentMethod,
           status: order.paymentStatus,
           paid: order.paymentStatus === 'PAID',
        }
      : undefined,
   timeline: (r.timeline ?? []).map((t: any) => ({ at: iso(t.at), event: t.event, actor: t.actor })),
})
