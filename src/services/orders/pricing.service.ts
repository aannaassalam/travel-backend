import { Types } from 'mongoose'
import { CURRENCIES, BASE_CURRENCY, Currency, VERTICALS } from '../../constants/domain.constants'
import { isScheduledRoute, Listing } from '../../model/listingModel'
import { Hotel, RoomType } from '../../model/hotelModel'
import { MenuItem, Restaurant } from '../../model/restaurantModel'
import { baseAmount, Money } from '../../model/shared.schema'
import { currentRates, inAllCurrencies } from '../fx.service'
import { nightsBetween } from './inventory.service'
import { scheduledDeparture } from './schedule.service'

/**
 * Server-side re-pricing.
 *
 * The client sends WHAT it wants, never WHAT IT COSTS. Every figure on an order
 * is read back out of the database here, because a price posted by a browser is
 * a price chosen by whoever is driving that browser. §5 also requires cost price
 * on every line for margin reporting, and cost price must never travel to a
 * public client in either direction — so the only place it can come from is a
 * lookup like this one.
 *
 * Prices are stored in USD; the other currencies of a line are worked out from
 * the office's exchange rates (fx.service), per unit and then multiplied, so a
 * CDF total is exactly the CDF prices the customer was shown added up.
 */

export interface Passengers {
   adults: number
   children: number
   infants: number
}

export interface Baggage {
   cabinKg: number
   checkedKg: number
}

export interface RequestedItem {
   vertical: string
   listingId?: string
   roomTypeId?: string
   startDate?: string
   endDate?: string
   quantity: number
   /** Bus and flight seats by fare. */
   passengers?: Partial<Passengers>
   /** Flights: what the customer will carry, in kg. */
   baggage?: Partial<Baggage>
}

export interface PricedItem {
   vertical: string
   listingId: Types.ObjectId
   listingLabel: string
   roomTypeId?: Types.ObjectId
   startDate?: Date
   endDate?: Date
   quantity: number
   unitSellPrice: number
   unitCostPrice: number
   lineTotal: number
   lineCost: number
   /** The line's total in each currency it can be charged in. */
   lineTotalByCurrency: Record<string, number>
   passengers?: Passengers
   baggage?: Baggage
   origin?: string
   destination?: string
}

const label = (value: any): string =>
   typeof value === 'string' ? value : value?.fr || value?.en || 'Article'

/**
 * §BUG-008: server-side date guard. The client sends WHICH dates, never whether
 * they are sane — a reversed range, a past date, or `endDate: "banana"` must be
 * refused here, not priced. Throws 'INVALID_DATES', which createOrder maps to 400.
 */
const DAY_MS = 86_400_000
const MAX_SPAN_DAYS = 365
const validateDates = (startRaw: string, endRaw: string) => {
   const start = new Date(startRaw).getTime()
   const end = new Date(endRaw).getTime()
   if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('INVALID_DATES')
   if (end <= start) throw new Error('INVALID_DATES')
   // Start of today in server time: a same-day booking is valid, yesterday is not.
   const today = new Date()
   today.setHours(0, 0, 0, 0)
   if (start < today.getTime()) throw new Error('INVALID_DATES')
   if ((end - start) / DAY_MS > MAX_SPAN_DAYS) throw new Error('INVALID_DATES')
}

/** A USD price times a count, in every currency it converts to. */
const scaled = (usdMinor: number, times: number): Record<string, number> => {
   const out: Record<string, number> = {}
   for (const [c, v] of Object.entries(inAllCurrencies(usdMinor))) out[c] = (v ?? 0) * times
   return out
}

/** Adds price lists together, currency by currency, keeping those every part has. */
const added = (...parts: Record<string, number>[]): Record<string, number> => {
   const out: Record<string, number> = {}
   for (const c of CURRENCIES) {
      if (parts.every((p) => typeof p[c] === 'number')) out[c] = parts.reduce((s, p) => s + p[c], 0)
   }
   return out
}

/**
 * Seats by fare, as asked for: whole numbers, at least one adult (a child or
 * a baby does not travel alone), no more babies than adults (one on each lap),
 * twenty seats at most, as for any other line.
 */
export const parsePassengers = (raw: any): Passengers => {
   const n = (v: unknown) => (v === undefined || v === null || v === '' ? 0 : Number(v))
   const p = { adults: n(raw?.adults), children: n(raw?.children), infants: n(raw?.infants) }
   const whole = Object.values(p).every((v) => Number.isInteger(v) && v >= 0)
   const total = p.adults + p.children + p.infants
   if (!whole || p.adults < 1 || p.infants > p.adults || total > 20) {
      throw new Error('INVALID_PASSENGERS')
   }
   return p
}

/** Flights: both weights, in kg, as the customer declares them (0 is "none"). */
export const parseBaggage = (raw: any): Baggage => {
   const kg = (v: unknown) => (v === '' || v === null || v === undefined ? NaN : Number(v))
   const b = { cabinKg: kg(raw?.cabinKg), checkedKg: kg(raw?.checkedKg) }
   if (Object.values(b).some((v) => !Number.isFinite(v) || v < 0 || v > 200)) {
      throw new Error('INVALID_BAGGAGE')
   }
   return { cabinKg: Math.round(b.cabinKg * 10) / 10, checkedKg: Math.round(b.checkedKg * 10) / 10 }
}

/**
 * A bus or flight booking: one departure from the route's timetable, and a
 * fare per passenger — adult, child (2–12) and baby (under 2) each pay their
 * own. There is no seat count to check; the agency is the one who confirms.
 */
const priceRouteItem = (listing: any, item: RequestedItem): PricedItem => {
   const attrs = listing.attributes ?? {}
   const departure = scheduledDeparture(attrs, item.startDate)
   if (!departure) throw new Error('INVALID_DEPARTURE')
   const p = parsePassengers(item.passengers)
   const baggage = listing.vertical === VERTICALS.FLIGHT ? parseBaggage(item.baggage) : undefined

   const fare = {
      adult: baseAmount(listing.sellPrice),
      child: baseAmount(listing.childSellPrice),
      infant: baseAmount(listing.infantSellPrice),
   }
   const cost = {
      adult: baseAmount(listing.costPrice),
      child: baseAmount(listing.childCostPrice),
      infant: baseAmount(listing.infantCostPrice),
   }
   return {
      vertical: listing.vertical,
      listingId: listing._id,
      listingLabel: label(listing.title),
      startDate: departure,
      quantity: p.adults + p.children + p.infants,
      // Per adult: the headline fare. The line total is the real sum.
      unitSellPrice: fare.adult,
      unitCostPrice: cost.adult,
      lineTotal: fare.adult * p.adults + fare.child * p.children + fare.infant * p.infants,
      lineCost: cost.adult * p.adults + cost.child * p.children + cost.infant * p.infants,
      lineTotalByCurrency: added(
         scaled(fare.adult, p.adults),
         scaled(fare.child, p.children),
         scaled(fare.infant, p.infants)
      ),
      passengers: p,
      baggage,
      origin: listing.city,
      destination: attrs.destination,
   }
}

export const priceListingItem = async (item: RequestedItem): Promise<PricedItem> => {
   const listing = await Listing.findOne({
      _id: item.listingId,
      status: 'PUBLISHED',
   })
   if (!listing) throw new Error('ITEM_UNAVAILABLE')
   if (listing.vertical === VERTICALS.PROPERTY) throw new Error('PROPERTY_IS_ENQUIRY_ONLY')
   if (isScheduledRoute(listing.vertical)) return priceRouteItem(listing, item)

   // A dated listing that has left is not for sale, whatever its status still
   // says: the job that marks it expired runs every ten minutes, not every
   // second. The same reading of "departed" as publishBlockers.
   const attrs = listing.attributes as any
   const departs = attrs?.departsAt ?? attrs?.segments?.[0]?.departsAt
   if (departs && new Date(departs).getTime() < Date.now()) throw new Error('ITEM_UNAVAILABLE')

   // §BUG-008: a dated product (car hire, dated activity) carries a range — guard it.
   if (item.startDate && item.endDate) validateDates(item.startDate, item.endDate)

   // Nights for a dated product, otherwise a single unit. Same helper the
   // margin maths uses, so revenue and cost always span the same period.
   const units =
      item.startDate && item.endDate
         ? Math.max(nightsBetween(new Date(item.startDate), new Date(item.endDate)).length, 1)
         : 1

   const sell = baseAmount(listing.sellPrice)
   const cost = baseAmount(listing.costPrice)
   return {
      vertical: listing.vertical,
      listingId: listing._id,
      listingLabel: label(listing.title),
      startDate: item.startDate ? new Date(item.startDate) : undefined,
      endDate: item.endDate ? new Date(item.endDate) : undefined,
      quantity: item.quantity,
      unitSellPrice: sell,
      unitCostPrice: cost,
      lineTotal: sell * item.quantity * units,
      lineCost: cost * item.quantity * units,
      lineTotalByCurrency: scaled(sell, item.quantity * units),
   }
}

/**
 * A hotel stay: the room type's nightly price, times the nights, times the
 * rooms. One price holds for every future night, and rooms are not counted —
 * the office decided neither should limit a booking.
 */
export const priceStayItem = async (item: RequestedItem): Promise<PricedItem> => {
   if (!item.roomTypeId || !item.startDate || !item.endDate) {
      throw new Error('STAY_REQUIRES_ROOM_AND_DATES')
   }
   // §BUG-008: reject invalid, reversed, past or absurdly long stays before pricing.
   validateDates(item.startDate, item.endDate)
   // The room has to be live, and so does its hotel — the same rule a dish and
   // its restaurant follow below. Without it a deactivated or archived hotel
   // left the catalogue but stayed bookable by anyone still holding a room id.
   const roomType = await RoomType.findOne({ _id: item.roomTypeId, status: 'PUBLISHED' })
   if (!roomType) throw new Error('ITEM_UNAVAILABLE')
   const hotel = await Hotel.exists({ _id: roomType.hotel, status: 'PUBLISHED' })
   if (!hotel) throw new Error('ITEM_UNAVAILABLE')

   const nights = nightsBetween(new Date(item.startDate), new Date(item.endDate)).length
   if (!nights) throw new Error('STAY_REQUIRES_AT_LEAST_ONE_NIGHT')

   const sell = baseAmount(roomType.sellPrice)
   const cost = baseAmount(roomType.costPrice)
   if (sell <= 0) throw new Error('ITEM_UNAVAILABLE')
   const qty = item.quantity

   return {
      vertical: VERTICALS.HOTEL,
      listingId: roomType.hotel,
      listingLabel: label((roomType as any).name),
      roomTypeId: roomType._id,
      startDate: new Date(item.startDate),
      endDate: new Date(item.endDate),
      quantity: qty,
      // Per night per room, so the admin's per-line arithmetic still reads true.
      unitSellPrice: sell,
      unitCostPrice: cost,
      lineTotal: sell * nights * qty,
      lineCost: cost * nights * qty,
      lineTotalByCurrency: scaled(sell, nights * qty),
   }
}

/**
 * A dish. The simplest line on the system: no dates, no nights, no allotment —
 * a quantity times a price.
 *
 * `isAvailable` is checked here rather than only in the menu query, because the
 * kitchen can 86 a dish while the customer is filling their cart. Re-reading it
 * at checkout is the difference between "sold out, we removed it" and taking
 * money for food nobody can cook.
 */
export const priceMenuItem = async (item: RequestedItem): Promise<PricedItem> => {
   const dish = await MenuItem.findOne({ _id: item.listingId, status: 'PUBLISHED' })
   if (!dish) throw new Error('ITEM_UNAVAILABLE')
   if (!dish.isAvailable) throw new Error('ITEM_UNAVAILABLE')

   // A dish on a restaurant that has since been unpublished is not sellable
   // either, and the menu query would never have returned it.
   const restaurant = await Restaurant.findOne({ _id: dish.restaurant, status: 'PUBLISHED' })
   if (!restaurant) throw new Error('ITEM_UNAVAILABLE')

   const sell = baseAmount(dish.sellPrice)
   const cost = baseAmount(dish.costPrice)
   return {
      vertical: VERTICALS.RESTAURANT,
      // The restaurant, not the dish: `listingId` is what the admin order view
      // links through to, and a dish on its own is not a page.
      listingId: dish.restaurant,
      listingLabel: label((dish as any).name),
      // Reusing the room-type slot for the dish keeps the order item shape
      // unchanged — it is already "the child record this line actually sold".
      roomTypeId: dish._id,
      quantity: item.quantity,
      unitSellPrice: sell,
      unitCostPrice: cost,
      lineTotal: sell * item.quantity,
      lineCost: cost * item.quantity,
      lineTotalByCurrency: scaled(sell, item.quantity),
   }
}

export const priceItem = (item: RequestedItem) => {
   if (item.vertical === VERTICALS.HOTEL) return priceStayItem(item)
   if (item.vertical === VERTICALS.RESTAURANT) return priceMenuItem(item)
   return priceListingItem(item)
}

/**
 * The delivery fee, shaped like a line so `settle` can treat it as one, and
 * converted the same way as the food it comes with.
 */
export const priceDelivery = (zone: any, restaurantLabel: string): PricedItem => {
   const fee = baseAmount(zone?.fee as Money)
   return {
      vertical: VERTICALS.RESTAURANT,
      listingId: zone._id,
      listingLabel: `Livraison — ${restaurantLabel}`,
      quantity: 1,
      unitSellPrice: fee,
      unitCostPrice: 0,
      lineTotal: fee,
      lineCost: 0,
      lineTotalByCurrency: scaled(fee, 1),
   }
}

/**
 * What the customer is actually charged: the lines in the currency they chose,
 * at today's rate — or USD when that currency has no rate set. The rate goes
 * on the order (`fxRate`, what 1 USD was worth) so a later change of rate never
 * moves a booking already made.
 */
export const settle = (items: PricedItem[], requested: string) => {
   const totalUsd = items.reduce((s, i) => s + i.lineTotal, 0)
   const everyLineHasIt =
      requested !== BASE_CURRENCY &&
      CURRENCIES.includes(requested as any) &&
      items.every((i) => typeof i.lineTotalByCurrency[requested] === 'number')

   if (!everyLineHasIt) {
      return { chargedCurrency: BASE_CURRENCY, chargedTotal: totalUsd, fxRate: 1, totalUsd }
   }
   const chargedTotal = items.reduce((s, i) => s + i.lineTotalByCurrency[requested], 0)
   return {
      chargedCurrency: requested,
      chargedTotal,
      fxRate: currentRates()[requested as Currency] ?? 1,
      totalUsd,
   }
}
