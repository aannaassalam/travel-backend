import { NextFunction, Request, Response } from 'express'
import slugify from 'slugify'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { LISTING_STATUS, LOCALES, VERTICALS } from '../../constants/domain.constants'
import { IListing, Listing } from '../../model/listingModel'
import { Location } from '../../model/locationModel'
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
   createDoc,
   deactivateDoc,
   paginate,
   sortBy,
   updateDoc,
} from '../../services/adminCrud.service'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { pick } from '../../utils/pick'
import { FieldMap, present, presentList } from '../../utils/present'
import { sendResponse } from '../../utils/response'
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
   'supplier',
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
   supplier: (l) => l.supplier,
   // Admin surface only — §2.1's canonical example of what must never leak.
   costPrice: (l) => l.costPrice,
   sellPrice: (l) => l.sellPrice,
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
         { 'attributes.make': rx },
         { 'attributes.model': rx },
      ]
   }

   const { items, ...paging } = await paginate(
      Listing,
      filter,
      req,
      sortBy(req.query.sort, { name: 'title.fr' })
   )
   return sendResponse(res, 200, 'OK', {
      items: presentList(items as any, listingFields),
      ...paging,
   })
})

export const getListing = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const listing = await Listing.findById(req.params.id)
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
      const listing = await createDoc<IListing>(
         req,
         Listing,
         {
            ...pick(req.body, LISTING_EDITABLE),
            vertical,
            costPrice: parseMoney(req.body.costPrice),
            sellPrice: parseMoney(req.body.sellPrice),
            geo: parseGeo(req.body.geo),
            slug: await uniqueSlug(Listing, [title, city]),
            createdBy: (req as any).admin._id,
         },
         { entityType: ENTITY }
      )
      return sendResponse(res, 201, 'Listing created', {
         listing: presentListing(listing),
      })
   }
)

export const updateListing = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      // Only when the city is actually being changed — an edit to the price of
      // a listing in a city that was later deactivated must still be possible.
      if (req.body.city !== undefined) {
         const current = await Listing.findById(req.params.id).select('vertical')
         const problem = await checkCity(req.body.city, current?.vertical)
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
         const from = new Date(req.body.validFrom)
         copy.validFrom = from
         if (req.body.validUntil) copy.validUntil = new Date(req.body.validUntil)
         const anchor = anchorDay(source)
         if (anchor && !Number.isNaN(from.getTime())) {
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

const DAY = 86_400_000
const MAX_RECURRENCE_DAYS = 366

/**
 * §5.2 bus recurrence: "repeat daily/weekly until date", or the same trip gets
 * hand-entered 90 times.
 */
export const expandRecurrence = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const source = await Listing.findById(req.params.id)
      if (!source) return next(new AppError('Listing not found', 404))

      const { frequency, daysOfWeek, until } = req.body
      if (!frequency || !until) {
         return next(new AppError('frequency and until are required', 400))
      }
      const start = anchorDay(source) || new Date(new Date().toISOString().slice(0, 10))
      const end = new Date(until)
      const days = Math.floor((end.getTime() - start.getTime()) / DAY)
      if (!(days >= 1)) return next(new AppError('until must be after the start', 400))
      // A year of departures at a time; the bound is also what keeps a date in
      // the year 275760 from being walked day by day.
      if (days > MAX_RECURRENCE_DAYS) {
         return next(new AppError('until is more than a year after the start', 400))
      }
      const weekdays = (Array.isArray(daysOfWeek) ? daysOfWeek : []).map(Number)

      const title = resolveLocalized(source.title)
      const wanted: { date: Date; slug: string }[] = []
      for (let n = 1; n <= days; n++) {
         const date = new Date(start.getTime() + n * DAY)
         if (frequency === 'WEEKLY' && !weekdays.includes(date.getUTCDay())) continue
         wanted.push({
            date,
            slug: slugify(`${title}-${source.city}-${date.toISOString().slice(0, 10)}`, {
               lower: true,
               strict: true,
            }),
         })
      }
      if (!wanted.length) {
         return next(new AppError('That pattern produces no additional dates', 400))
      }
      // Asked again with a later "until", only the new days are added: the ones
      // already made keep whatever was changed on them since.
      const have = new Set(
         await Listing.distinct('slug', { slug: { $in: wanted.map((w) => w.slug) } })
      )
      const missing = wanted.filter((w) => !have.has(w.slug))
      if (!missing.length) {
         return next(new AppError('Those departures already exist', 409))
      }

      const base = source.toObject() as any
      const created = await Listing.insertMany(
         missing.map(({ date, slug }) => {
            const copy = { ...base }
            delete copy._id
            delete copy.__v
            delete copy.id
            delete copy.createdAt
            delete copy.updatedAt
            // Each departure is published by hand, not by the source's schedule.
            delete copy.publishAt
            delete copy.unpublishAt
            // Earned by the original, not by a departure nobody has taken yet.
            delete copy.rating
            copy.reviewCount = 0
            copy.createdBy = (req as any).admin._id
            copy.attributes = shiftTimes(base.attributes, date.getTime() - start.getTime())
            copy.validFrom = date
            copy.validUntil = source.validUntil
               ? new Date(date.getTime() + (source.validUntil.getTime() - start.getTime()))
               : undefined
            copy.slug = slug
            copy.status = LISTING_STATUS.INACTIVE
            copy.quantitySold = 0
            copy.quantityHeld = 0
            return copy
         })
      )

      // One audit entry for the batch — 90 rows of noise would bury the signal.
      await recordAudit(req, {
         action: AUDIT_ACTIONS.CREATE,
         entityType: ENTITY,
         entityId: source._id.toString(),
         after: { expandedFrom: source.slug, created: created.length, frequency, until },
      })

      return sendResponse(res, 201, `${created.length} departure(s) created`, {
         created: created.length,
         alreadyThere: wanted.length - missing.length,
      })
   }
)
