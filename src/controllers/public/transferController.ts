import { NextFunction, Request, Response } from 'express'
import { presentPublicCategory, presentPublicPlace, presentPublicRide } from '../../dto/public/transfer.dto'
import { Location } from '../../model/locationModel'
import { Order } from '../../model/orderModel'
import { Ride } from '../../model/rideModel'
import { geoPoint } from '../../model/shared.schema'
import { TransferPlace } from '../../model/transferPlaceModel'
import { VehicleCategory } from '../../model/vehicleCategoryModel'
import { inAllCurrencies } from '../../services/fx.service'
import { insideDrc, nameAt, searchPlaces } from '../../services/transfers/geocoding.service'
import { haversineKm } from '../../services/transfers/routing.service'
import { assertCityServed, parseQuoteRequest, quoteRide } from '../../services/transfers/quote.service'
import { MAX_RATING_COMMENT, raiseAlert, rateRide } from '../../services/transfers/rideLifecycle'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'
import { sameName } from '../../utils/sameName'

/**
 * Transfers, customer side: the categories to choose from, the places to pick
 * up at, a quote — and, on a booked ride, the rating and the security alert.
 * Nothing here prices anything a client sent: see transfers/quote.service.
 */

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, max) : '')

/** GET /transfers/categories — the active categories, cheapest arrangement first (sortOrder). */
export const listCategories = catchAsync(async (_req: Request, res: Response) => {
   const items = await VehicleCategory.find({ isActive: true }).sort({ sortOrder: 1, 'name.fr': 1 }).limit(50)
   return sendResponse(res, 200, 'OK', { items: items.map(presentPublicCategory) })
})

/**
 * For matching what a customer types against a place's name: no accents, case,
 * apostrophes or hyphens — on a phone "hotel memling" means "Hôtel Memling"
 * and "ndjili" means "N'djili".
 */
const fold = (s: string) =>
   s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/['’`-]/g, '')
      .toLowerCase()

/**
 * GET /transfers/places?city=&q= — the office's saved places of the city (each
 * word typed found in its French or English name), and from three letters, up
 * to five suggestions from the map provider when one is configured (its key
 * never leaves this server).
 */
export const listPlaces = catchAsync(async (req: Request, res: Response) => {
   const city = text(req.query.city, 80)
   const q = text(req.query.q, 80)
   if (!city) return sendResponse(res, 200, 'OK', { items: [] })

   const [saved, location] = await Promise.all([
      // ponytail: matched here rather than in Mongo, which has no accent-blind
      // regex; fine for an office's few hundred places per city.
      TransferPlace.find({ city: sameName(city), isActive: true }).sort({ sortOrder: 1, 'name.fr': 1 }).limit(500),
      q.length >= 3 ? Location.findOne({ name: sameName(city), isActive: true }).select('geo').lean() : null,
   ])
   const words = fold(q).split(/\s+/).filter(Boolean)
   const places = saved
      .filter((p) => {
         const name = fold(`${p.name?.fr ?? ''} ${p.name?.en ?? ''}`)
         return words.every((w) => name.includes(w))
      })
      .slice(0, 50)
   const external = q.length >= 3 ? await searchPlaces(q, city, geoPoint((location as any)?.geo)) : []
   return sendResponse(res, 200, 'OK', { items: [...places.map(presentPublicPlace), ...external] })
})

/** A saved place this close to a map point lends it its name. */
const NEAR_PLACE_KM = 0.1
/** The box searched around the point, in degrees: about 110 m in the DRC, which straddles the equator. */
const NEAR_PLACE_DEG = 0.001

/**
 * GET /transfers/places/reverse?lat=&lng= — what to call a point picked on the
 * map or read from the device: the office's own place when one is within
 * 100 m (it knows the airport better than any map), else the map provider's
 * address, else nothing and the customer's screen names it by its coordinates.
 */
export const nameMapPoint = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   // A blank value would read as 0 — a real place, on the equator.
   const given = (v: unknown) => (typeof v === 'string' && v.trim() ? Number(v) : NaN)
   const lat = given(req.query.lat)
   const lng = given(req.query.lng)
   if (!Number.isFinite(lat) || !Number.isFinite(lng) || !insideDrc({ lat, lng })) {
      return next(new AppError('That point is outside the DRC', 400, 'INVALID_POINT'))
   }
   const near = await TransferPlace.find({
      isActive: true,
      lat: { $gte: lat - NEAR_PLACE_DEG, $lte: lat + NEAR_PLACE_DEG },
      lng: { $gte: lng - NEAR_PLACE_DEG, $lte: lng + NEAR_PLACE_DEG },
   }).limit(20)
   const closest = near
      .map((place) => ({ place, km: haversineKm(place, { lat, lng }) }))
      .filter((x) => x.km <= NEAR_PLACE_KM)
      .sort((a, b) => a.km - b.km)[0]
   if (closest) return sendResponse(res, 200, 'OK', { item: presentPublicPlace(closest.place) })

   const name = await nameAt({ lat, lng })
   if (name === undefined) {
      // Not asked (MapTiler down, the hour's calls spent): nobody may keep this
      // answer — not the edge, not the customer's screen — or the point would
      // stay unnamed for as long as they cache it.
      res.set('Cache-Control', 'no-store')
      return next(new AppError('Naming the point is unavailable right now', 503, 'NAMING_UNAVAILABLE'))
   }
   return sendResponse(res, 200, 'OK', { item: name ? { name, lat, lng, external: true } : null })
})

/** POST /transfers/quote — every category priced for the ride, so the customer compares. */
export const quoteTransfer = catchAsync(async (req: Request, res: Response) => {
   const q = parseQuoteRequest(req.body)
   await assertCityServed(q.city)
   const { distance, distanceKm, durationMinutes, quotes } = await quoteRide(q)
   return sendResponse(res, 200, 'OK', {
      distanceKm,
      durationMinutes,
      routeSource: distance?.source ?? 'ESTIMATE',
      route: distance?.route,
      // The price only — never the cost beside it.
      quotes: quotes.map(({ category, price }) => {
         const shown = presentPublicCategory(category)
         return {
            categoryId: shown.id,
            name: shown.name,
            image: shown.image,
            seats: category.seats,
            luggage: shown.luggage,
            price: inAllCurrencies(price),
            available: category.seats >= q.passengers,
         }
      }),
   })
})

/**
 * The ride behind a booking reference. One answer for "no such booking" and
 * "not a transfer": which references exist is not for a prober to learn.
 */
const rideOfReference = async (reference: unknown) => {
   const order = await Order.findOne({ reference: String(reference ?? '').toUpperCase() }).select('_id')
   const ride = order
      ? await Ride.findOne({ order: order._id })
           .populate('driver', 'name phone photo ratingStats')
           .populate('vehicle', 'make model color plate')
      : null
   if (!ride) throw new AppError('Booking not found', 404)
   return ride
}

/**
 * A form posted from another site carries no JSON content type; refusing
 * anything else keeps a cross-site form from rating or alerting on someone's
 * behalf (the reference is the only key these routes need).
 */
export const jsonOnly = (req: Request, next: NextFunction) => {
   if (req.is('application/json')) return true
   next(new AppError('Send the request as JSON', 415))
   return false
}

/** POST /orders/:reference/transfer/rate { score, comment } — once, after the ride. */
export const rateTransfer = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!jsonOnly(req, next)) return
   const score = Number(req.body?.score)
   if (req.body?.comment !== undefined && req.body?.comment !== null && typeof req.body.comment !== 'string') {
      return next(new AppError('The comment must be text', 400))
   }
   const comment = text(req.body?.comment, MAX_RATING_COMMENT)
   const ride = await rideOfReference(req.params.reference)
   await rateRide(ride, score, comment)
   return sendResponse(res, 200, 'Thank you for rating your driver', { ride: presentPublicRide(ride) })
})

/** A position the browser shared, or nothing — never a guess. */
export const parseLocation = (body: any) => {
   const lat = Number(body?.lat)
   const lng = Number(body?.lng)
   const given = body?.lat !== undefined && body?.lat !== null && body?.lat !== ''
   if (!given) return undefined
   if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined
   return { lat, lng }
}

/** POST /orders/:reference/transfer/alert { lat?, lng?, note? } — works for a guest holding the reference. */
export const alertTransfer = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!jsonOnly(req, next)) return
   const ride = await rideOfReference(req.params.reference)
   const { sent, officePhone } = await raiseAlert(ride, 'CUSTOMER', parseLocation(req.body), text(req.body?.note, 300))
   return sendResponse(res, 200, sent ? 'Alert sent to the office' : 'Alert recorded', {
      sent,
      officePhone: officePhone || undefined,
      ride: presentPublicRide(ride),
   })
})
