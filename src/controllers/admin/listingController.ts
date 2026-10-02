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
   paginate,
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

   const { items, nextCursor } = await paginate(Listing, filter, req)
   return sendResponse(res, 200, 'OK', {
      items: presentList(items as any, listingFields),
      nextCursor,
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

export const publishListing = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const listing = await Listing.findById(req.params.id)
      if (!listing) return next(new AppError('Listing not found', 404))

      const blockers = listing.publishBlockers()
      if (blockers.length) {
         return next(new AppError(`Cannot publish: ${blockers.join('; ')}`, 400))
      }
      const updated = await updateDoc<IListing>(
         req,
         Listing,
         req.params.id,
         { status: LISTING_STATUS.PUBLISHED },
         { entityType: ENTITY }
      )
      return sendResponse(res, 200, 'Listing published', {
         listing: presentListing(updated),
      })
   }
)

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
      copy.title = req.body.title || {
         ...source.title,
         fr: `${resolveLocalized(source.title)} (copie)`,
      }
      copy.slug = await uniqueSlug(Listing, [resolveLocalized(copy.title), copy.city])
      copy.status = LISTING_STATUS.DRAFT
      copy.quantitySold = 0
      copy.quantityHeld = 0

      // "Duplicate with new dates" — shift the whole validity window.
      if (req.body.validFrom) {
         copy.validFrom = new Date(req.body.validFrom)
         if (req.body.validUntil) copy.validUntil = new Date(req.body.validUntil)
         if (copy.attributes?.departsAt && source.validFrom) {
            const shift =
               new Date(req.body.validFrom).getTime() - source.validFrom.getTime()
            copy.attributes.departsAt = new Date(
               new Date(copy.attributes.departsAt).getTime() + shift
            )
            if (copy.attributes.arrivesAt) {
               copy.attributes.arrivesAt = new Date(
                  new Date(copy.attributes.arrivesAt).getTime() + shift
               )
            }
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
      const end = new Date(until)
      const start = source.validFrom || new Date()
      if (end <= start) return next(new AppError('until must be after the start', 400))

      const dates: Date[] = []
      for (
         let d = new Date(start);
         d <= end && dates.length <= 366;
         d.setUTCDate(d.getUTCDate() + 1)
      ) {
         if (d.getTime() === start.getTime()) continue // the source itself
         if (frequency === 'WEEKLY' && !(daysOfWeek || []).includes(d.getUTCDay())) {
            continue
         }
         dates.push(new Date(d))
      }
      if (!dates.length) {
         return next(new AppError('That pattern produces no additional dates', 400))
      }

      const base = source.toObject() as any
      const created = await Listing.insertMany(
         dates.map((date) => {
            const copy = { ...base }
            delete copy._id
            delete copy.__v
            delete copy.id
            copy.validFrom = date
            copy.validUntil = source.validUntil
               ? new Date(date.getTime() + (source.validUntil.getTime() - start.getTime()))
               : undefined
            copy.slug = slugify(
               `${source.title}-${source.city}-${date.toISOString().slice(0, 10)}`,
               { lower: true, strict: true }
            )
            copy.status = LISTING_STATUS.DRAFT
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
      })
   }
)

/**
 * §5.1 / §2.2: bulk CSV import per vertical, with a downloadable template, a
 * DRY-RUN validation report carrying row-level errors, then commit.
 *
 * Essential for launch loading and for the spreadsheets the client already has
 * (§18 Q7). Dry-run is the default — committing requires an explicit flag, so a
 * malformed file can never half-load a catalogue.
 */
const CSV_COLUMNS = [
   'title_fr',
   'title_en',
   'city',
   'description_fr',
   'description_en',
   'cost_price_usd',
   'sell_price_usd',
   // Optional explicit prices. Blank means "not sold in that currency" — never
   // a conversion.
   'sell_price_cdf',
   'sell_price_eur',
   'quantity',
   'valid_from',
   'supplier',
] as const

export const csvTemplate = catchAsync(async (req: Request, res: Response) => {
   const vertical = String(req.query.vertical || 'BUS')
   const example =
      vertical === 'PROPERTY'
         ? 'Villa 4 chambres,4-bedroom villa,Kinshasa,Belle villa à Gombe,Fine villa in Gombe,0,250000,,,1,,Agence Gombe'
         : 'Kinshasa → Lubumbashi,Kinshasa → Lubumbashi,Kinshasa,Départ quotidien 08h00,Daily 08:00 departure,45,70,196000,64,40,2026-09-01,Transco'
   res.set('Content-Type', 'text/csv')
   res.set('Content-Disposition', `attachment; filename="${vertical.toLowerCase()}-template.csv"`)
   return res.send(`${CSV_COLUMNS.join(',')}\n${example}\n`)
})

/** Minimal RFC-4180 parse: handles quoted fields containing commas. */
const parseCsv = (text: string): Record<string, string>[] => {
   const rows: string[][] = []
   let field = ''
   let row: string[] = []
   let inQuotes = false
   for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inQuotes) {
         if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
         else if (c === '"') inQuotes = false
         else field += c
      } else if (c === '"') inQuotes = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else if (c !== '\r') field += c
   }
   if (field || row.length) { row.push(field); rows.push(row) }

   const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()))
   if (!header) return []
   return body.map((r) =>
      Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()]))
   )
}

const usdToMinor = (v: string) => Math.round(Number(v || 0) * 100)

export const importListingsCsv = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { vertical, csv, commit } = req.body
      if (!vertical || !Object.values(VERTICALS).includes(vertical)) {
         return next(new AppError('A valid vertical is required', 400))
      }
      if (vertical === VERTICALS.HOTEL) {
         return next(new AppError('Hotel import uses the calendar, not this endpoint', 400))
      }
      if (!csv || typeof csv !== 'string') {
         return next(new AppError('csv content is required', 400))
      }

      const rows = parseCsv(csv)
      if (!rows.length) return next(new AppError('No data rows found', 400))
      if (rows.length > 1000) {
         return next(new AppError('Import is limited to 1000 rows per file', 400))
      }

      const isProperty = vertical === VERTICALS.PROPERTY
      const errors: { row: number; field: string; message: string }[] = []
      const prepared: any[] = []

      rows.forEach((r, idx) => {
         const rowNo = idx + 2 // +1 for header, +1 for 1-based
         const push = (field: string, message: string) =>
            errors.push({ row: rowNo, field, message })

         if (!r.title_fr) push('title_fr', 'French title is required')
         if (!r.city) push('city', 'City is required')
         if (!r.description_fr) push('description_fr', 'French description is required')

         const cost = usdToMinor(r.cost_price_usd)
         const sell = usdToMinor(r.sell_price_usd)
         if (!isProperty) {
            if (!cost) push('cost_price_usd', 'Cost price is required — margin reporting depends on it')
            if (!sell) push('sell_price_usd', 'Sell price is required')
            if (sell && cost && sell <= cost) {
               push('sell_price_usd', 'Sell price must be above cost price')
            }
            if (!Number(r.quantity)) push('quantity', 'Quantity must be above zero')
         }

         // Older spreadsheets still carry a valid_until column; it is ignored.
         prepared.push({
            vertical,
            title: { fr: r.title_fr, en: r.title_en || '' },
            city: r.city,
            description: { fr: r.description_fr, en: r.description_en || '' },
            costPrice: { USD: cost },
            sellPrice: {
               USD: sell,
               // Only set when the column carries a value — an empty cell must
               // not become a zero price.
               ...(r.sell_price_cdf ? { CDF: usdToMinor(r.sell_price_cdf) } : {}),
               ...(r.sell_price_eur ? { EUR: usdToMinor(r.sell_price_eur) } : {}),
            },
            quantityTotal: Number(r.quantity) || 0,
            validFrom: r.valid_from ? new Date(r.valid_from) : undefined,
            supplier: r.supplier || undefined,
            status: LISTING_STATUS.DRAFT,
            slug: slugify(`${r.title_fr}-${r.city}-${Date.now()}-${idx}`, {
               lower: true,
               strict: true,
            }),
            createdBy: (req as any).admin._id,
         })
      })

      // Dry run by default — report first, commit only when asked.
      if (!commit) {
         return sendResponse(res, 200, 'Validation report', {
            dryRun: true,
            rows: rows.length,
            validRows: rows.length - new Set(errors.map((e) => e.row)).size,
            errors,
            canCommit: errors.length === 0,
         })
      }
      if (errors.length) {
         return next(
            new AppError('Fix the reported errors before committing', 400)
         )
      }

      // §2.2: transactional — all rows land or none do.
      const session = await Listing.startSession()
      let created = 0
      try {
         await session.withTransaction(async () => {
            const docs = await Listing.insertMany(prepared, { session })
            created = docs.length
         })
      } catch (err: any) {
         await session.endSession()
         return next(new AppError(`Import failed and was rolled back: ${err.message}`, 400))
      }
      await session.endSession()

      await recordAudit(req, {
         action: AUDIT_ACTIONS.CREATE,
         entityType: ENTITY,
         after: { imported: created, vertical },
         reason: `CSV import of ${created} ${vertical} listings`,
      })

      return sendResponse(res, 201, `${created} listing(s) imported as drafts`, {
         created,
      })
   }
)
