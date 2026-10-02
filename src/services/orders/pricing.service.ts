import { Types } from 'mongoose'
import { CURRENCIES, BASE_CURRENCY, VERTICALS } from '../../constants/domain.constants'
import { Listing } from '../../model/listingModel'
import { RatePlan, RoomType } from '../../model/hotelModel'
import { MenuItem, Restaurant } from '../../model/restaurantModel'
import { nightsBetween } from './inventory.service'

/**
 * Server-side re-pricing.
 *
 * The client sends WHAT it wants, never WHAT IT COSTS. Every figure on an order
 * is read back out of the database here, because a price posted by a browser is
 * a price chosen by whoever is driving that browser. §5 also requires cost price
 * on every line for margin reporting, and cost price must never travel to a
 * public client in either direction — so the only place it can come from is a
 * lookup like this one.
 */

export interface RequestedItem {
   vertical: string
   listingId?: string
   roomTypeId?: string
   startDate?: string
   endDate?: string
   quantity: number
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
   /** Per-currency line totals, present only where a real typed price exists. */
   lineTotalByCurrency: Record<string, number>
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

/** A currency is only offered when every component of the price was typed in it. */
const intersectCurrencies = (a: Record<string, number>, b: Record<string, number>) => {
   const out: Record<string, number> = {}
   for (const c of Object.keys(a)) if (typeof b[c] === 'number') out[c] = a[c] + b[c]
   return out
}

export const priceListingItem = async (item: RequestedItem): Promise<PricedItem> => {
   const listing = await Listing.findOne({
      _id: item.listingId,
      status: 'PUBLISHED',
   })
   if (!listing) throw new Error('ITEM_UNAVAILABLE')
   if (listing.vertical === VERTICALS.PROPERTY) throw new Error('PROPERTY_IS_ENQUIRY_ONLY')

   // §BUG-008: a dated product (car hire, dated activity) carries a range — guard it.
   if (item.startDate && item.endDate) validateDates(item.startDate, item.endDate)

   // Nights for a dated product, otherwise a single unit. Same helper the
   // margin maths uses, so revenue and cost always span the same period.
   const units =
      item.startDate && item.endDate
         ? Math.max(nightsBetween(new Date(item.startDate), new Date(item.endDate)).length, 1)
         : 1

   const sell = (listing.sellPrice as any) ?? {}
   const cost = (listing.costPrice as any) ?? {}
   const byCurrency: Record<string, number> = {}
   for (const c of CURRENCIES) {
      if (typeof sell[c] === 'number' && sell[c] > 0) {
         byCurrency[c] = sell[c] * item.quantity * units
      }
   }

   return {
      vertical: listing.vertical,
      listingId: listing._id,
      listingLabel: label(listing.title),
      startDate: item.startDate ? new Date(item.startDate) : undefined,
      endDate: item.endDate ? new Date(item.endDate) : undefined,
      quantity: item.quantity,
      unitSellPrice: sell[BASE_CURRENCY] ?? 0,
      unitCostPrice: cost[BASE_CURRENCY] ?? 0,
      lineTotal: (sell[BASE_CURRENCY] ?? 0) * item.quantity * units,
      lineCost: (cost[BASE_CURRENCY] ?? 0) * item.quantity * units,
      lineTotalByCurrency: byCurrency,
   }
}

/**
 * A hotel stay is priced night by night from the rate plans, never from a
 * nightly rate multiplied out — the whole point of a per-night calendar is that
 * a weekend can cost more than a Tuesday.
 */
export const priceStayItem = async (item: RequestedItem): Promise<PricedItem> => {
   if (!item.roomTypeId || !item.startDate || !item.endDate) {
      throw new Error('STAY_REQUIRES_ROOM_AND_DATES')
   }
   // §BUG-008: reject invalid, reversed, past or absurdly long stays before pricing.
   validateDates(item.startDate, item.endDate)
   const roomType = await RoomType.findById(item.roomTypeId)
   if (!roomType) throw new Error('ITEM_UNAVAILABLE')

   const dates = nightsBetween(new Date(item.startDate), new Date(item.endDate))
   if (!dates.length) throw new Error('STAY_REQUIRES_AT_LEAST_ONE_NIGHT')

   const plans = await RatePlan.find({ roomType: roomType._id, date: { $in: dates } })
   if (plans.length !== dates.length) throw new Error('ITEM_UNAVAILABLE')

   let sellUsd = 0
   let costUsd = 0
   let byCurrency: Record<string, number> | null = null

   for (const p of plans) {
      const sell = (p.sellPrice as any) ?? {}
      const cost = (p.costPrice as any) ?? {}
      sellUsd += sell[BASE_CURRENCY] ?? 0
      costUsd += cost[BASE_CURRENCY] ?? 0

      const night: Record<string, number> = {}
      for (const c of CURRENCIES) {
         if (typeof sell[c] === 'number' && sell[c] > 0) night[c] = sell[c]
      }
      byCurrency = byCurrency === null ? night : intersectCurrencies(byCurrency, night)
   }

   const qty = item.quantity
   const scaled: Record<string, number> = {}
   for (const [c, v] of Object.entries(byCurrency ?? {})) scaled[c] = v * qty

   return {
      vertical: VERTICALS.HOTEL,
      listingId: roomType.hotel,
      listingLabel: label((roomType as any).name),
      roomTypeId: roomType._id,
      startDate: dates[0],
      endDate: new Date(item.endDate),
      quantity: qty,
      // Per night per room, so the admin's per-line arithmetic still reads true.
      unitSellPrice: Math.round(sellUsd / dates.length),
      unitCostPrice: Math.round(costUsd / dates.length),
      lineTotal: sellUsd * qty,
      lineCost: costUsd * qty,
      lineTotalByCurrency: scaled,
   }
}

/**
 * A dish. The simplest line on the system: no dates, no nights, no allotment —
 * a quantity times a typed price.
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

   const sell = (dish.sellPrice as any) ?? {}
   const cost = (dish.costPrice as any) ?? {}
   const byCurrency: Record<string, number> = {}
   for (const c of CURRENCIES) {
      if (typeof sell[c] === 'number' && sell[c] > 0) byCurrency[c] = sell[c] * item.quantity
   }

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
      unitSellPrice: sell[BASE_CURRENCY] ?? 0,
      unitCostPrice: cost[BASE_CURRENCY] ?? 0,
      lineTotal: (sell[BASE_CURRENCY] ?? 0) * item.quantity,
      lineCost: (cost[BASE_CURRENCY] ?? 0) * item.quantity,
      lineTotalByCurrency: byCurrency,
   }
}

export const priceItem = (item: RequestedItem) => {
   if (item.vertical === VERTICALS.HOTEL) return priceStayItem(item)
   if (item.vertical === VERTICALS.RESTAURANT) return priceMenuItem(item)
   return priceListingItem(item)
}

/**
 * The delivery fee, shaped like a line so `settle` can treat it as one.
 *
 * It has to take part in the currency decision, not be added afterwards: a fee
 * typed only in USD means the order cannot honestly settle in CDF, exactly as a
 * dish priced only in USD does. Adding it after the fact would either convert
 * it — which §5 forbids — or quietly charge a USD fee inside a CDF total.
 */
export const priceDelivery = (zone: any, restaurantLabel: string): PricedItem => {
   const fee = (zone?.fee as any) ?? {}
   const byCurrency: Record<string, number> = {}
   for (const c of CURRENCIES) {
      if (typeof fee[c] === 'number') byCurrency[c] = fee[c]
   }
   return {
      vertical: VERTICALS.RESTAURANT,
      listingId: zone._id,
      listingLabel: `Livraison — ${restaurantLabel}`,
      quantity: 1,
      unitSellPrice: fee[BASE_CURRENCY] ?? 0,
      unitCostPrice: 0,
      lineTotal: fee[BASE_CURRENCY] ?? 0,
      lineCost: 0,
      lineTotalByCurrency: byCurrency,
   }
}

/**
 * What the customer is actually charged.
 *
 * §5: a converted figure is never presented as the charge. If every line has a
 * real typed price in the requested currency we settle in it; otherwise we fall
 * back to the USD base rather than inventing a rate at checkout.
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
      fxRate: totalUsd ? chargedTotal / totalUsd : 1,
      totalUsd,
   }
}
