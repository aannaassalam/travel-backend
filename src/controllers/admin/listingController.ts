import { NextFunction, Request, Response } from 'express'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { LISTING_STATUS, LOCALES, VERTICALS } from '../../constants/domain.constants'
import { IListing, isScheduledRoute, Listing } from '../../model/listingModel'
import { Location, ServicedRoute } from '../../model/locationModel'
import { Supplier } from '../../model/supplierModel'
import { cleanTimetable } from '../../services/orders/schedule.service'
import { supplierRef } from './supplierController'
import {
   availableCurrencies,
   baseAmount,
   geoPoint,
   parseGeo,
   parseMoney,
   resolveLocalized,
   translationStatus,
} from '../../model/shared.schema'
import { getSettings } from '../../model/settingsModel'
import {
   archiveDoc,
   confirmOverOpenBookings,
   deleteDoc,
   createDoc,
   deactivateDoc,
   paginate,
   sortBy,
   translatedCount,
   updateDoc,
} from '../../services/adminCrud.service'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { pick } from '../../utils/pick'
import { FieldMap, present, presentList } from '../../utils/present'
import { sendResponse } from '../../utils/response'
import { writtenDay } from '../../utils/dayRange'
import { uniqueSlug } from '../../utils/uniqueSlug'

/** Serves flights, bus, cars, activities and properties (§5.2). */

/**
 * §BUG-010: fields a caller may set on a listing. costPrice/sellPrice/geo are
 * parsed and written explicitly below; slug, status, createdBy, quantitySold,
 * quantityHeld, rating and reviewCount are never taken from the body — status
 * moves only through publish/archive, inventory counts only through checkout.
 */
const LISTING_EDITABLE = [
   'title',
   'description',
   'city',
   'country',
   'images',
   'videoUrl',
   'quantityTotal',
   'validFrom',
   'validUntil',
   'attributes',
   'publishAt',
   'unpublishAt',
] as const

const listingFields: FieldMap<IListing> = {
   id: (l) => l._id.toString(),
   vertical: (l) => l.vertical,
   title: (l) => l.title,
   displayTitle: (l) => resolveLocalized(l.title),
   slug: (l) => l.slug,
   description: (l) => l.description,
   status: (l) => l.status,
   city: (l) => l.city,
   country: (l) => l.country,
   geo: (l) => geoPoint(l.geo),
   images: (l) => l.images,
   videoUrl: (l) => l.videoUrl,
   // The id, whether or not the record was read with its supplier alongside.
   supplier: (l) => ((l.supplier as any)?._id ?? l.supplier)?.toString(),
   supplierName: (l) => (l.supplier as any)?.name,
   // Admin surface only — §2.1's canonical example of what must never leak.
   costPrice: (l) => l.costPrice,
   sellPrice: (l) => l.sellPrice,
   childCostPrice: (l) => (isScheduledRoute(l.vertical) ? l.childCostPrice : undefined),
   childSellPrice: (l) => (isScheduledRoute(l.vertical) ? l.childSellPrice : undefined),
   infantCostPrice: (l) => (isScheduledRoute(l.vertical) ? l.infantCostPrice : undefined),
   infantSellPrice: (l) => (isScheduledRoute(l.vertical) ? l.infantSellPrice : undefined),
   costPriceBase: (l) => baseAmount(l.costPrice),
   sellPriceBase: (l) => baseAmount(l.sellPrice),
   currencies: (l) => availableCurrencies(l.sellPrice),
   margin: (l) => baseAmount(l.sellPrice) - baseAmount(l.costPrice),
   quantityTotal: (l) => l.quantityTotal,
   quantitySold: (l) => l.quantitySold,
   available: (l) =>
      Math.max(l.quantityTotal - l.quantitySold - l.quantityHeld, 0),
   validFrom: (l) => l.validFrom,
   validUntil: (l) => l.validUntil,
   attributes: (l) => l.attributes,
   publishAt: (l) => l.publishAt,
   unpublishAt: (l) => l.unpublishAt,
   translations: (l) => {
      const t = translationStatus(l.title)
      const d = translationStatus(l.description)
      return Object.fromEntries(
         Object.keys(t).map((k) => [k, t[k] && d[k]])
      ) as Record<string, boolean>
   },
   version: (l) => (l as any).__v,
   updatedAt: (l) => l.updatedAt,
}

export const presentListing = (l: IListing) => present(l, listingFields)

const ENTITY = 'Listing'

/** Free-text search box: NUL stripped (the driver throws on it) and capped so a pasted paragraph never becomes a regex. */
const searchTerm = (v: unknown) =>
   typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, 80) : ''
const searchRx = (value: string) =>
   new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

export const listListings = catchAsync(async (req: Request, res: Response) => {
   const { vertical, status, city, q } = req.query
   const filter: Record<string, any> = {}
   if (vertical) filter.vertical = vertical
   filter.status = status ? status : { $ne: LISTING_STATUS.ARCHIVED }
   if (city) filter.city = city
   // Search every locale — an English-speaking admin should still find a
   // listing whose French title is the only one filled in — plus the fields
   // a caller actually quotes: slug, city, carrier, flight number, route,
   // bus operator, car make/model.
   const term = searchTerm(q)
   if (term) {
      const rx = searchRx(term)
      filter.$or = [
         ...LOCALES.map((l) => ({ [`title.${l}`]: rx })),
         { slug: rx },
         { city: rx },
         { 'attributes.segments.carrier': rx },
         { 'attributes.segments.flightNumber': rx },
         { 'attributes.segments.origin': rx },
         { 'attributes.segments.destination': rx },
         { 'attributes.operator': rx },
         { 'attributes.destination': rx },
         { 'attributes.make': rx },
         { 'attributes.model': rx },
      ]
   }

   const { items, ...paging } = await paginate(
      Listing,
      filter,
      req,
      // One key per column of the panel's listing tables (the properties
      // table shows `sell` as Price). Margin and what is left to sell are
      // worked out, as the list itself works them out for display.
      { populate: 'supplier', ...sortBy(req.query.sort, {
         name: 'title.fr',
         city: 'city',
         status: 'status',
         cost: 'costPrice.USD',
         sell: 'sellPrice.USD',
         margin: {
            value: {
               $subtract: [{ $ifNull: ['$sellPrice.USD', 0] }, { $ifNull: ['$costPrice.USD', 0] }],
            },
         },
         available: {
            value: {
               $max: [
                  {
                     $subtract: [
                        { $ifNull: ['$quantityTotal', 0] },
                        { $add: [{ $ifNull: ['$quantitySold', 0] }, { $ifNull: ['$quantityHeld', 0] }] },
                     ],
                  },
                  0,
               ],
            },
         },
         translations: { value: translatedCount('title', LOCALES) },
         updated: 'updatedAt',
      }) }
   )
   return sendResponse(res, 200, 'OK', {
      items: presentList(items as any, listingFields),
      ...paging,
   })
})

export const getListing = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const listing = await Listing.findById(req.params.id).populate('supplier')
      if (!listing) return next(new AppError('Listing not found', 404))
      return sendResponse(res, 200, 'OK', {
         listing: presentListing(listing),
         // Surfaced so the form can show what still blocks publishing.
         publishBlockers: listing.publishBlockers(),
      })
   }
)

/**
 * §12: a listing may only name a place the office has said it services.
 *
 * `city` used to be free text, so one typo ("Kinshsa") invented a city that
 * then appeared in the public filter facets forever, and the search box offered
 * a hardcoded list that had nothing to do with either. Validating on write is
 * what stops the two drifting apart again — the location list is the single
 * source of truth, and this is the gate onto it.
 */
const checkCity = async (city: unknown, vertical?: string) => {
   const name = typeof city === 'string' ? city.trim() : ''
   if (!name) return new AppError('A city is required', 400)

   const known = await Location.findOne({ name, isActive: true })
   if (!known) {
      const exists = await Location.findOne({ name })
      return new AppError(
         exists
            ? `${name} is switched off in Locations. Re-activate it before selling there.`
            : `${name} is not in your serviced locations. Add it under Locations first.`,
         400,
         'UNKNOWN_LOCATION'
      )
   }

   /**
    * Serving a city for one product does not mean serving it for all of them.
    * A town the coach passes through is not somewhere we can hire out a car,
    * and letting inventory be filed there anyway is how `servesVerticals` stops
    * describing reality — which is the whole point of the list.
    */
   if (vertical && !known.servesVerticals.includes(vertical as never)) {
      return new AppError(
         `${name} is not set up to sell ${vertical}. Tick ${vertical} for ${name} under Locations first.`,
         400,
         'VERTICAL_NOT_SERVICED'
      )
   }
   return null
}

/** The four bus and flight fares besides the adult one, as sent (undefined = untouched). */
const FARES = ['childCostPrice', 'childSellPrice', 'infantCostPrice', 'infantSellPrice'] as const

/**
 * What a save writes besides the plain fields: the supplier (an id from the
 * list), the extra fares, and for a bus or flight route its timetable — real
 * times only — and its operator name, which is its agency's name. The
 * destination of a route is a serviced place, like its departure point.
 */
const routeAndSupplier = async (
   body: any,
   vertical: string,
   patch: Record<string, any>,
   currentDestination?: string
) => {
   const supplier = await supplierRef(body.supplier)
   if (supplier !== undefined) patch.supplier = supplier
   for (const key of FARES) {
      if (body[key] !== undefined) patch[key] = parseMoney(body[key])
   }
   if (!isScheduledRoute(vertical) || !patch.attributes) return
   const attributes = { ...patch.attributes, ...cleanTimetable(patch.attributes) }
   // A route has no single departure: what an old dated offer carried would
   // only have the nightly job expire it once that day had passed.
   for (const dated of ['departsAt', 'arrivesAt', 'segments', 'tripType', 'recurrence', 'bookingDeadline']) {
      delete attributes[dated]
   }
   // Like the city: only when it changes — a place switched off later must not
   // stop the office editing a route's fares.
   if (attributes.destination && attributes.destination !== currentDestination) {
      const problem = await checkCity(attributes.destination, vertical)
      if (problem) throw problem
   }
   if (supplier) attributes.operator = (await Supplier.findById(supplier).select('name'))?.name
   else if (supplier === null) delete attributes.operator
   patch.attributes = attributes
}

/**
 * Once a route is on sale, the search box offers it: the pair of places goes
 * on the serviced routes, the list it builds its "To" choices from. A pair the
 * office switched off by hand stays off.
 */
const offerRoute = async (l: IListing) => {
   const destination = (l.attributes as any)?.destination
   if (!isScheduledRoute(l.vertical) || !destination) return
   const [from, to] = await Promise.all([
      Location.findOne({ name: l.city }).select('_id'),
      Location.findOne({ name: destination }).select('_id'),
   ])
   if (!from || !to) return
   await ServicedRoute.updateOne(
      { vertical: l.vertical, origin: from._id, destination: to._id },
      { $setOnInsert: { isActive: true } },
      { upsert: true }
   )
}

export const createListing = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { vertical, city } = req.body
      const title = resolveLocalized(req.body.title)
      if (!vertical || !Object.values(VERTICALS).includes(vertical)) {
         return next(new AppError('A valid vertical is required', 400))
      }
      if (vertical === VERTICALS.HOTEL) {
         // Hotels have their own three-level structure and endpoints (§5.2).
         return next(
            new AppError('Use /hotels for hotel inventory', 400)
         )
      }
      const cityProblem = await checkCity(city, vertical)
      if (cityProblem) return next(cityProblem)
      const data: Record<string, any> = {
         ...pick(req.body, LISTING_EDITABLE),
         vertical,
         costPrice: parseMoney(req.body.costPrice),
         sellPrice: parseMoney(req.body.sellPrice),
         geo: parseGeo(req.body.geo),
         slug: await uniqueSlug(Listing, [title, city]),
         createdBy: (req as any).admin._id,
      }
      await routeAndSupplier(req.body, vertical, data)
      const listing = await createDoc<IListing>(req, Listing, data, { entityType: ENTITY })
      return sendResponse(res, 201, 'Listing created', {
         listing: presentListing(listing),
      })
   }
)

export const updateListing = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const current = await Listing.findById(req.params.id).select('vertical city attributes.destination')
      if (!current) return next(new AppError('Listing not found', 404))
      // Only when the city is actually being changed — an edit to the price of
      // a listing in a city that was later deactivated must still be possible.
      if (req.body.city !== undefined && req.body.city !== current.city) {
         const problem = await checkCity(req.body.city, current.vertical)
         if (problem) return next(problem)
      }
      /**
       * §5.1 price-change guard, applied to single listings the same way the
       * hotel calendar applies it to a night range. A mis-keyed price that gets
       * purchased is painful to unwind under a no-refund policy.
       */
      if (req.body.sellPrice !== undefined && !req.body.confirmPriceChange) {
         const current = await Listing.findById(req.params.id)
         const currentBase = baseAmount(current?.sellPrice)
         const nextBase = baseAmount(parseMoney(req.body.sellPrice))
         // Guard on the base currency: it is the one price every listing has.
         if (current && currentBase > 0 && current.status === LISTING_STATUS.PUBLISHED) {
            const guard = (await getSettings()).priceChangeGuardPercent
            const delta = Math.abs(nextBase - currentBase)
            if ((delta / currentBase) * 100 > guard) {
               return next(
                  new AppError(
                     `This changes a published price by more than ${guard}%. Resend with confirmPriceChange to proceed.`,
                     409
                  )
               )
            }
         }
      }

      // §BUG-010: never spread the raw body — vertical is immutable on update.
      const patch: Record<string, any> = pick(req.body, LISTING_EDITABLE)
      if (req.body.costPrice !== undefined) patch.costPrice = parseMoney(req.body.costPrice)
      if (req.body.sellPrice !== undefined) patch.sellPrice = parseMoney(req.body.sellPrice)
      patch.geo = parseGeo(req.body.geo)
      await routeAndSupplier(
         req.body,
         current.vertical,
         patch,
         (current.attributes as any)?.destination
      )

      const listing = await updateDoc<IListing>(req, Listing, req.params.id, patch, {
         entityType: ENTITY,
      })
      return sendResponse(res, 200, 'Listing updated', {
         listing: presentListing(listing),
      })
   }
)

/** A scheduled take-down still to come, with a "publish at" after it. */
const returnsLater = (l: IListing) =>
   Boolean(
      l.unpublishAt &&
         l.publishAt &&
         l.unpublishAt.getTime() > Date.now() &&
         l.publishAt.getTime() > l.unpublishAt.getTime()
   )

/**
 * A copy made for another date leaves on that date: every departure and
 * arrival on it moves by the same amount — the listing's own pair and each
 * flight leg. Left behind, every repeat of a service carried the first one's
 * time, and all of them stopped selling the moment the first had left.
 */
const shiftTimes = (attributes: any, ms: number) => {
   if (!attributes || !ms) return attributes
   const move = (d: unknown) => (d ? new Date(new Date(d as any).getTime() + ms) : d)
   return {
      ...attributes,
      departsAt: move(attributes.departsAt),
      arrivesAt: move(attributes.arrivesAt),
      segments: (attributes.segments ?? []).map((leg: any) => ({
         ...leg,
         departsAt: move(leg.departsAt),
         arrivesAt: move(leg.arrivesAt),
      })),
   }
}

/**
 * The day a listing's dates are counted from: the day it leaves, or its start
 * date when it has no departure (a car, an activity). The day only — a start
 * date typed with a time of day would otherwise move a 06:30 bus to 22:30 on
 * every copy.
 */
const anchorDay = (l: IListing): Date | null => {
   const attrs = l.attributes as any
   const from = attrs?.departsAt ?? attrs?.segments?.[0]?.departsAt ?? l.validFrom
   const day = from ? new Date(from) : null
   return day && !Number.isNaN(day.getTime()) ? new Date(day.toISOString().slice(0, 10)) : null
}

export const publishListing = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const listing = await Listing.findById(req.params.id)
      if (!listing) return next(new AppError('Listing not found', 404))

      const blockers = listing.publishBlockers()
      if (blockers.length) {
         return next(new AppError(`Cannot publish: ${blockers.join('; ')}`, 400))
      }
      await offerRoute(listing)
      /**
       * Publishing is also how an inactive or expired listing comes back, so it
       * has to stick. A sell-by date the panel can no longer show or change
       * would have the nightly job expire the listing again a few hours later;
       * one already in the past can only be a leftover, and goes.
       */
      const past = (d?: Date | null) => Boolean(d && d.getTime() < Date.now())
      const updated = await updateDoc<IListing>(
         req,
         Listing,
         req.params.id,
         {
            status: LISTING_STATUS.PUBLISHED,
            ...(past(listing.validUntil) ? { validUntil: null } : {}),
            // It is published now, so a pending "publish at" has nothing left
            // to do — and would publish it again after a later deactivation.
            // Kept only when it is the way back from a take-down still ahead
            // ("down at 22:00, up again at 23:00").
            ...(returnsLater(listing) ? {} : { publishAt: null }),
            // Same leftover in the other direction: a take-down time that has
            // already passed would undo this publish at the next ten-minute run.
            ...(past(listing.unpublishAt) ? { unpublishAt: null } : {}),
         },
         { entityType: ENTITY }
      )
      return sendResponse(res, 200, 'Listing published', {
         listing: presentListing(updated),
      })
   }
)

/**
 * Off the website and unbookable, but still in the list — publish to undo.
 * Someone taking it down by hand outranks a schedule: a "publish at" left on
 * the record would otherwise put it back on sale within ten minutes.
 */
export const deactivateListing = catchAsync(async (req: Request, res: Response) => {
   const listing = await deactivateDoc<IListing>(
      req,
      Listing,
      req.params.id,
      { entityType: ENTITY },
      { publishAt: undefined }
   )
   return sendResponse(res, 200, 'Listing deactivated', {
      listing: presentListing(listing),
   })
})

export const archiveListing = catchAsync(async (req: Request, res: Response) => {
   const listing = await archiveDoc<IListing>(req, Listing, req.params.id, {
      entityType: ENTITY,
   })
   return sendResponse(res, 200, 'Listing archived', {
      listing: presentListing(listing),
   })
})

/**
 * DELETE /listings/:id — for good. Bookings that sold it keep their own copy
 * of what was sold (an order line is a snapshot), so none of them changes.
 */
export const deleteListing = catchAsync(async (req: Request, res: Response) => {
   await confirmOverOpenBookings(req, { 'items.listingId': req.params.id }, 'this listing')
   await deleteDoc(req, Listing, { _id: req.params.id }, { entityType: ENTITY })
   return sendResponse(res, 200, 'Listing deleted', {})
})

/** §5.1: clone, and clone-with-new-dates — the highest-leverage feature. */
export const duplicateListing = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const source = await Listing.findById(req.params.id)
      if (!source) return next(new AppError('Listing not found', 404))

      const copy = source.toObject() as any
      delete copy._id
      delete copy.__v
      delete copy.createdAt
      delete copy.updatedAt
      delete copy.id
      // A sell-by date belongs to the departure it was set for, and the panel
      // has no way to change it on the copy.
      delete copy.validUntil
      // Nor does a copy inherit the original's schedule: a "publish at" already
      // in the past would put it on sale minutes after it was made.
      delete copy.publishAt
      delete copy.unpublishAt
      copy.createdBy = (req as any).admin._id
      // Earned by the original, not by a copy nobody has bought — and the
      // panel has no way to correct a score that came along by mistake.
      delete copy.rating
      copy.reviewCount = 0
      // A copy made by hand is a listing of its own, not one of the days a
      // "repeat until" made.
      delete copy.repeatOf
      copy.title = req.body.title || {
         ...source.title,
         fr: `${resolveLocalized(source.title)} (copie)`,
      }
      copy.slug = await uniqueSlug(Listing, [resolveLocalized(copy.title), copy.city])
      // A clone always starts inactive — never silently publish a copy.
      copy.status = LISTING_STATUS.INACTIVE
      copy.quantitySold = 0
      copy.quantityHeld = 0

      // "Duplicate with new dates" — the copy leaves on the new day, at the
      // same times of day as the original.
      if (req.body.validFrom) {
         // The day as written. Taken with its time of day, `…T08:00` moved a
         // 06:30 departure to 14:30.
         const from = writtenDay(req.body.validFrom)
         if (!from) return next(new AppError('validFrom must be a date (YYYY-MM-DD)', 400))
         copy.validFrom = from
         if (req.body.validUntil) copy.validUntil = new Date(req.body.validUntil)
         const anchor = anchorDay(source)
         if (anchor) {
            copy.attributes = shiftTimes(copy.attributes, from.getTime() - anchor.getTime())
         }
      }

      const listing = await createDoc<IListing>(req, Listing, copy, {
         entityType: ENTITY,
      })
      return sendResponse(res, 201, 'Listing duplicated', {
         listing: presentListing(listing),
      })
   }
)
