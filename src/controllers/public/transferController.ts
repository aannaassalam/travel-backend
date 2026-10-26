import { NextFunction, Request, Response } from 'express'
import { presentPublicCategory, presentPublicPlace, presentPublicRide } from '../../dto/public/transfer.dto'
import { Location } from '../../model/locationModel'
import { Order } from '../../model/orderModel'
import { Ride } from '../../model/rideModel'
import { geoPoint } from '../../model/shared.schema'
import { TransferPlace } from '../../model/transferPlaceModel'
import { VehicleCategory } from '../../model/vehicleCategoryModel'
import { inAllCurrencies } from '../../services/fx.service'
import { searchPlaces } from '../../services/transfers/geocoding.service'
import { assertCityServed, parseQuoteRequest, quoteRide } from '../../services/transfers/quote.service'
import { MAX_RATING_COMMENT, raiseAlert, rateRide } from '../../services/transfers/rideLifecycle'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'
import { escapeRx, sameName } from '../../utils/sameName'

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
 * GET /transfers/places?city=&q= — the office's saved places of the city, and
 * from three letters, up to five suggestions from the map provider when one is
 * configured (its key never leaves this server).
 */
export const listPlaces = catchAsync(async (req: Request, res: Response) => {
   const city = text(req.query.city, 80)
   const q = text(req.query.q, 80)
   if (!city) return sendResponse(res, 200, 'OK', { items: [] })

   const filter: Record<string, unknown> = { city: sameName(city), isActive: true }
   if (q) {
      const rx = new RegExp(escapeRx(q), 'i')
      filter.$or = [{ 'name.fr': rx }, { 'name.en': rx }]
   }
   const [places, location] = await Promise.all([
      TransferPlace.find(filter).sort({ sortOrder: 1, 'name.fr': 1 }).limit(50),
      q.length >= 3 ? Location.findOne({ name: sameName(city), isActive: true }).select('geo').lean() : null,
   ])
   const external = q.length >= 3 ? await searchPlaces(q, city, geoPoint((location as any)?.geo)) : []
   return sendResponse(res, 200, 'OK', { items: [...places.map(presentPublicPlace), ...external] })
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
