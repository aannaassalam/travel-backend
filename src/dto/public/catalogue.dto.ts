import { IHotel, IRoomType } from '../../model/hotelModel'
import { IListing } from '../../model/listingModel'
import { IMenuItem, IRestaurant } from '../../model/restaurantModel'
import { Localized, Money } from '../../model/shared.schema'
import { FieldMap, present, presentList } from '../../utils/present'

/** Only the locales that actually have text — blanks are noise on the wire. */
const localized = (value: Localized | string | undefined) => {
   if (!value) return {}
   if (typeof value === 'string') return { fr: value }
   return Object.fromEntries(
      Object.entries(value).filter(([, v]) => typeof v === 'string' && v.trim())
   )
}

/** Only the currencies with a real price — an unset one is simply not offered. */
const pickMoney = (value: Money | number | undefined) => {
   if (typeof value === 'number') return { USD: value }
   if (!value) return { USD: 0 }
   const out: Record<string, number> = {}
   for (const c of ['USD', 'CDF', 'EUR'] as const) {
      const v = (value as any)[c]
      if (typeof v === 'number' && v > 0) out[c] = v
   }
   return Object.keys(out).length ? out : { USD: 0 }
}

/**
 * Public catalogue DTOs. §14.3 rule 2: nothing here is shared with src/dto/admin
 * — separate file, separate field list, no common base object.
 *
 * Absent on purpose and permanently: `costPrice`, `supplier`, `createdBy`,
 * internal notes, raw quantity columns, and the Mongo `_id` of anything the
 * public reaches by slug. §14.3 rule 3 lists cost price and supplier as things
 * that must never appear on the public API under any circumstance — the way to
 * guarantee that is for the serialiser to have no field for them at all.
 */

const listingFields: FieldMap<IListing> = {
   id: (l) => l._id.toString(),
   vertical: (l) => l.vertical,
   /** Localised: the client picks a locale, the API does not decide for it. */
   title: (l) => localized(l.title),
   slug: (l) => l.slug,
   description: (l) => localized(l.description),
   status: (l) => l.status,
   city: (l) => l.city,
   country: (l) => l.country,
   images: (l) => l.images ?? [],
   /**
    * Per-currency integer minor units. Explicit prices, not conversions — the
    * customer is charged what the administrator typed. Sell only: cost never
    * leaves the admin surface.
    */
   sellPrice: (l) => pickMoney(l.sellPrice),
   /** §4.5 availability, computed. The raw sold/held columns stay internal. */
   available: (l) =>
      Math.max((l.quantityTotal ?? 0) - (l.quantitySold ?? 0) - (l.quantityHeld ?? 0), 0),
   validFrom: (l) => l.validFrom?.toISOString(),
   validUntil: (l) => l.validUntil?.toISOString(),
   rating: (l) => (l as any).rating,
   reviewCount: (l) => (l as any).reviewCount,
   attributes: (l) => {
      const a = (l.attributes as any)?.toObject
         ? (l.attributes as any).toObject()
         : { ...(l.attributes as any) }
      if (!a) return {}
      delete a._id
      // Dates must leave as ISO 8601 strings (§8): the client formats with
      // Intl, and a Date instance would serialise inconsistently.
      if (Array.isArray(a.segments)) {
         a.segments = a.segments.map((s: any) => ({
            carrier: s.carrier,
            flightNumber: s.flightNumber,
            origin: s.origin,
            destination: s.destination,
            departsAt: s.departsAt?.toISOString?.() ?? s.departsAt,
            arrivesAt: s.arrivesAt?.toISOString?.() ?? s.arrivesAt,
         }))
      }
      if (a.departsAt) a.departsAt = a.departsAt?.toISOString?.() ?? a.departsAt
      if (a.arrivesAt) a.arrivesAt = a.arrivesAt?.toISOString?.() ?? a.arrivesAt
      delete a.blackoutDates
      delete a.bookingDeadline
      delete a.recurrence
      return a
   },
}

export const presentListing = (l: IListing) => present(l, listingFields)
export const presentListings = (l: IListing[]) => presentList(l, listingFields)

/* ------------------------------------------------------------------- hotels */

export interface RoomTypeWithPrice extends IRoomType {
   /** Per-currency minor units, resolved from the rate plans for the nights asked for. */
   sellPrice?: Money
   available?: number
   mealPlan?: string
}

const roomTypeFields: FieldMap<RoomTypeWithPrice> = {
   id: (r) => r._id.toString(),
   hotelId: (r) => r.hotel.toString(),
   name: (r) => localized(r.name),
   description: (r) => localized(r.description),
   maxAdults: (r) => r.maxAdults,
   maxChildren: (r) => r.maxChildren,
   beds: (r) => r.beds,
   amenities: (r) => r.amenities ?? [],
   images: (r) => r.images ?? [],
   mealPlan: (r) => r.mealPlan ?? 'ROOM_ONLY',
   sellPrice: (r) => pickMoney(r.sellPrice),
   available: (r) => r.available ?? 0,
   sizeSqm: (r) => (r as any).sizeSqm,
}

export interface HotelWithRooms extends IHotel {
   fromPrice?: Money
   roomTypes?: RoomTypeWithPrice[]
}

const hotelFields: FieldMap<HotelWithRooms> = {
   id: (h) => h._id.toString(),
   name: (h) => localized(h.name),
   slug: (h) => h.slug,
   description: (h) => localized(h.description),
   stars: (h) => h.stars,
   address: (h) => h.address,
   city: (h) => h.city,
   country: (h) => h.country,
   geo: (h) => (h.geo?.lat ? { lat: h.geo.lat, lng: h.geo.lng } : undefined),
   amenities: (h) => h.amenities ?? [],
   images: (h) => h.images ?? [],
   checkInTime: (h) => h.checkInTime,
   checkOutTime: (h) => h.checkOutTime,
   policies: (h) => h.policies,
   rating: (h) => (h as any).rating,
   reviewCount: (h) => (h as any).reviewCount,
   fromPrice: (h) => pickMoney(h.fromPrice),
   roomTypes: (h) => presentList(h.roomTypes ?? [], roomTypeFields),
}

export const presentHotel = (h: HotelWithRooms) => present(h, hotelFields)
export const presentHotels = (h: HotelWithRooms[]) => presentList(h, hotelFields)

// ---------------------------------------------------------------------------

/**
 * Restaurants and their menus.
 *
 * `costPrice` has no entry here and never will — same rule as every other
 * sellable thing (§14.3 rule 3). Because these maps are allow-lists, leaving it
 * out is the whole protection: a field the serialiser cannot name is a field it
 * cannot publish, however the document is later extended.
 */

export interface MenuItemPublic extends IMenuItem {}

const menuItemFields: FieldMap<IMenuItem> = {
   id: (m) => m._id.toString(),
   restaurantId: (m) => m.restaurant.toString(),
   section: (m) => m.section,
   name: (m) => localized(m.name),
   description: (m) => localized(m.description),
   sellPrice: (m) => pickMoney(m.sellPrice),
   images: (m) => m.images ?? [],
   /** Drives the greyed-out "sold out today" row rather than hiding the dish. */
   isAvailable: (m) => m.isAvailable !== false,
   sortOrder: (m) => m.sortOrder ?? 0,
}

/**
 * Zones are public: the customer has to see the fee before they commit, and
 * §1 is explicit that a cost appearing only at the last step is the thing that
 * loses the order. The fee is still re-read server-side at checkout.
 */
const deliveryZoneFields: FieldMap<any> = {
   id: (z) => z._id.toString(),
   name: (z) => z.name,
   fee: (z) => pickMoney(z.fee),
   minOrder: (z) => (z.minOrder?.USD ? pickMoney(z.minOrder) : undefined),
   etaMinutes: (z) => z.etaMinutes,
}

export interface RestaurantWithMenu extends IRestaurant {
   fromPrice?: Money
   menu?: IMenuItem[]
}

const restaurantFields: FieldMap<RestaurantWithMenu> = {
   id: (r) => r._id.toString(),
   name: (r) => localized(r.name),
   slug: (r) => r.slug,
   description: (r) => localized(r.description),
   cuisines: (r) => r.cuisines ?? [],
   address: (r) => r.address,
   city: (r) => r.city,
   country: (r) => r.country,
   geo: (r) => (r.geo?.lat ? { lat: r.geo.lat, lng: r.geo.lng } : undefined),
   images: (r) => r.images ?? [],
   openingHours: (r) => r.openingHours,
   prepTimeMinutes: (r) => r.prepTimeMinutes,
   phone: (r) => r.phone,
   rating: (r) => (r as any).rating,
   reviewCount: (r) => (r as any).reviewCount,
   // Inactive zones are not offered, so they are not published either.
   deliveryZones: (r) =>
      presentList((r.deliveryZones ?? []).filter((z: any) => z.isActive), deliveryZoneFields),
   fromPrice: (r) => pickMoney(r.fromPrice),
   menu: (r) => presentList(r.menu ?? [], menuItemFields),
}

export const presentRestaurant = (r: RestaurantWithMenu) => present(r, restaurantFields)
export const presentRestaurants = (r: RestaurantWithMenu[]) =>
   presentList(r, restaurantFields)
