import { Types } from 'mongoose'
import { CURRENCIES, BASE_CURRENCY, VERTICALS } from '../../constants/domain.constants'
import { Listing } from '../../model/listingModel'
import { RatePlan, RoomType } from '../../model/hotelModel'
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

export const priceItem = (item: RequestedItem) =>
   item.vertical === VERTICALS.HOTEL ? priceStayItem(item) : priceListingItem(item)

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
