import { Types } from 'mongoose'
import { VERTICALS } from '../../constants/domain.constants'
import { Location } from '../../model/locationModel'
import { RIDE_MODES, RideMode } from '../../model/rideModel'
import { getSettings } from '../../model/settingsModel'
import { resolveLocalized } from '../../model/shared.schema'
import { IVehicleCategory, VehicleCategory } from '../../model/vehicleCategoryModel'
import AppError from '../../utils/appError'
import { sameName } from '../../utils/sameName'
import { inAllCurrencies } from '../fx.service'
import type { PricedItem, RequestedItem } from '../orders/pricing.service'
import { KINSHASA_OFFSET } from '../orders/schedule.service'
import { insideDrc } from './geocoding.service'
import { MAX_HOURS, quoteFare } from './pricing'
import { Distance, distanceBetween, haversineKm } from './routing.service'

/**
 * A transfer quote: what the customer asks for, checked, then priced for every
 * category at once so they can compare. The same code prices the order line at
 * checkout (`priceTransferItem`), so a booking can never cost other than its
 * quote — and a price posted by a browser is never read.
 */

export interface QuotePoint {
   label: string
   lat: number
   lng: number
   placeId?: Types.ObjectId
}

export interface QuoteRequest {
   city: string
   mode: RideMode
   pickup: QuotePoint
   dropoff?: QuotePoint
   /** Wall-clock, stored as every other time: as written, no zone. */
   at: Date
   hours?: number
   passengers: number
   categoryId?: string
   notes?: string
}

/** A ride can be booked from half an hour ahead up to three months out. */
export const MIN_LEAD_MS = 30 * 60_000
export const MAX_AHEAD_MS = 90 * 86_400_000
export const MAX_PASSENGERS = 60
/** Two points closer than this are one place. */
const MIN_APART_KM = 0.1

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, max) : '')

const parsePoint = (raw: any, what: string, required: boolean): QuotePoint | undefined => {
   if (raw === undefined || raw === null || raw === '') {
      if (required) throw new AppError(`The ${what} is required`, 400, 'POINT_REQUIRED')
      return undefined
   }
   const label = text(raw?.label, 200)
   const lat = Number(raw?.lat)
   const lng = Number(raw?.lng)
   if (!label || !Number.isFinite(lat) || !Number.isFinite(lng) || !insideDrc({ lat, lng })) {
      throw new AppError(`Choose the ${what} on the map or from the list`, 400, 'INVALID_POINT')
   }
   const placeId = Types.ObjectId.isValid(String(raw?.placeId ?? '')) ? new Types.ObjectId(String(raw.placeId)) : undefined
   return { label, lat, lng, placeId }
}

/**
 * "YYYY-MM-DDTHH:MM" (seconds and a Z tolerated) → the stored instant. Judged
 * in Kinshasa time: at least half an hour from now, at most 90 days out.
 */
export const parseRideTime = (raw: unknown, now = Date.now()): Date => {
   const m = String(raw ?? '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
   const bad = new AppError('Choose a date and time at least 30 minutes from now, within 90 days', 400, 'INVALID_TIME')
   if (!m) throw bad
   const [, day, time] = m
   // `Date` rolls 2026-02-31 into March; a date that is not real is refused.
   if (new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) throw bad
   const local = Date.parse(`${day}T${time}:00${KINSHASA_OFFSET}`)
   if (Number.isNaN(local) || local < now + MIN_LEAD_MS || local > now + MAX_AHEAD_MS) throw bad
   return new Date(`${day}T${time}:00.000Z`)
}

/** The request as the customer sent it, checked field by field. Pure: no database. */
export const parseQuoteRequest = (raw: any, now = Date.now()): QuoteRequest => {
   if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AppError('The transfer details are missing', 400, 'TRANSFER_REQUIRED')
   }
   const city = text(raw.city, 80)
   if (!city) throw new AppError('Choose a city', 400, 'CITY_REQUIRED')
   const mode = raw.mode === RIDE_MODES.HOURLY ? RIDE_MODES.HOURLY : raw.mode === RIDE_MODES.DISTANCE ? RIDE_MODES.DISTANCE : null
   if (!mode) throw new AppError('Choose a journey or a number of hours', 400, 'INVALID_MODE')

   const pickup = parsePoint(raw.pickup, 'pick-up point', true)!
   const dropoff = parsePoint(raw.dropoff, 'destination', mode === RIDE_MODES.DISTANCE)
   if (dropoff && haversineKm(pickup, dropoff) < MIN_APART_KM) {
      throw new AppError('The destination is the same place as the pick-up point', 400, 'SAME_POINTS')
   }

   let hours: number | undefined
   if (mode === RIDE_MODES.HOURLY) {
      hours = Number(raw.hours)
      if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) {
         throw new AppError(`Choose from 1 to ${MAX_HOURS} hours`, 400, 'INVALID_HOURS')
      }
   }
   const passengers = Number(raw.passengers)
   if (!Number.isInteger(passengers) || passengers < 1 || passengers > MAX_PASSENGERS) {
      throw new AppError(`Passengers: from 1 to ${MAX_PASSENGERS}`, 400, 'INVALID_PASSENGERS')
   }
   const categoryId = raw.categoryId ? String(raw.categoryId) : undefined
   if (categoryId && !Types.ObjectId.isValid(categoryId)) {
      throw new AppError('Unknown vehicle category', 400, 'INVALID_CATEGORY')
   }
   const notes = text(raw.notes, 300) || undefined

   return { city, mode, pickup, dropoff, at: parseRideTime(raw.at, now), hours, passengers, categoryId, notes }
}

/** The city has to be one the office serves with transfers (its Locations screen). */
export const assertCityServed = async (city: string) => {
   const served = await Location.exists({ name: sameName(city), isActive: true, servesVerticals: VERTICALS.TRANSFER })
   if (!served) throw new AppError('We do not offer transfers in that city yet', 400, 'CITY_NOT_SERVED')
}

export interface CategoryQuote {
   category: IVehicleCategory
   price: number
   cost: number
}

export interface RideQuote {
   distance: Distance | null
   distanceKm: number
   durationMinutes: number
   /** Every active category priced for this ride; one when `categoryId` narrows it. */
   quotes: CategoryQuote[]
}

/**
 * Routes the journey (or takes the hours), then prices every active category
 * that sells the mode. A category without the mode's price is simply not
 * offered, not an error.
 */
export const quoteRide = async (q: QuoteRequest): Promise<RideQuote> => {
   const settings = await getSettings()
   const distance = q.dropoff ? await distanceBetween(q.pickup, q.dropoff, settings.transferDetourFactor) : null
   const distanceKm = distance?.km ?? 0
   const durationMinutes = q.mode === RIDE_MODES.HOURLY ? q.hours! * 60 : distance!.minutes

   const categories = await VehicleCategory.find({
      isActive: true,
      ...(q.categoryId ? { _id: q.categoryId } : {}),
   })
      .sort({ sortOrder: 1, 'name.fr': 1 })
      .limit(50)

   const quotes: CategoryQuote[] = []
   for (const category of categories) {
      try {
         quotes.push({ category, ...quoteFare(category, { mode: q.mode, km: distanceKm, hours: q.hours }) })
      } catch {
         // Not priced for this mode: left out.
      }
   }
   return { distance, distanceKm, durationMinutes, quotes }
}

/** What the order line says: "Transfert · Aéroport de Ndjili → Hôtel Memling". */
export const rideLabel = (q: Pick<QuoteRequest, 'mode' | 'pickup' | 'dropoff' | 'hours'>) =>
   q.mode === RIDE_MODES.HOURLY
      ? `Transfert à l'heure · ${q.pickup.label} · ${q.hours} h`
      : `Transfert · ${q.pickup.label} → ${q.dropoff?.label ?? ''}`

/** Everything the Ride is created from, once the order exists (see orderController). */
export interface RideDraft {
   mode: RideMode
   city: string
   pickup: QuotePoint
   dropoff?: QuotePoint
   at: Date
   hours?: number
   passengers: number
   category: Types.ObjectId
   categoryName: string
   distanceKm: number
   durationMinutes: number
   routeSource: 'ROUTING' | 'ESTIMATE'
   route?: number[][]
   price: { CDF: number }
   cost: { CDF: number }
   notes?: string
}

/**
 * The TRANSFER line of an order: re-quoted here from the request's points and
 * category, never from a client price. `listingId` is the id the Ride will be
 * created under, so the line can be written before the ride exists.
 */
export const priceTransferItem = async (item: RequestedItem): Promise<PricedItem> => {
   if (item.quantity !== 1) throw new AppError('A transfer is booked one ride at a time', 400, 'TRANSFER_QUANTITY')
   const q = parseQuoteRequest(item.transfer)
   if (!q.categoryId) throw new AppError('Choose a vehicle category', 400, 'CATEGORY_REQUIRED')
   await assertCityServed(q.city)

   const { distance, distanceKm, durationMinutes, quotes } = await quoteRide(q)
   const chosen = quotes[0]
   if (!chosen) throw new AppError('That vehicle category is no longer available for this ride', 409, 'CATEGORY_UNAVAILABLE')
   if (chosen.category.seats < q.passengers) {
      throw new AppError(`That vehicle takes up to ${chosen.category.seats} passengers`, 400, 'TOO_MANY_PASSENGERS')
   }

   const draft: RideDraft = {
      mode: q.mode,
      city: q.city,
      pickup: q.pickup,
      dropoff: q.dropoff,
      at: q.at,
      hours: q.hours,
      passengers: q.passengers,
      category: chosen.category._id,
      categoryName: resolveLocalized(chosen.category.name),
      distanceKm,
      durationMinutes,
      routeSource: distance?.source ?? 'ESTIMATE',
      route: distance?.route,
      price: { CDF: chosen.price },
      cost: { CDF: chosen.cost },
      notes: q.notes,
   }
   return {
      vertical: VERTICALS.TRANSFER,
      listingId: new Types.ObjectId(),
      listingLabel: rideLabel(q),
      startDate: q.at,
      quantity: 1,
      unitSellPrice: chosen.price,
      unitCostPrice: chosen.cost,
      lineTotal: chosen.price,
      lineCost: chosen.cost,
      lineTotalByCurrency: { ...inAllCurrencies(chosen.price) } as Record<string, number>,
      transfer: draft,
   }
}
