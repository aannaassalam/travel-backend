import { Request, Response } from 'express'
import { LISTING_STATUS, VERTICALS } from '../../constants/domain.constants'
import {
   HotelWithRooms,
   presentHotel,
   presentHotels,
   presentListing,
   presentListings,
   RoomTypeWithPrice,
} from '../../dto/public/catalogue.dto'
import { Hotel, RatePlan, RoomType } from '../../model/hotelModel'
import { Money } from '../../model/shared.schema'
import { Listing } from '../../model/listingModel'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Public catalogue. Read-only, unauthenticated, cacheable.
 *
 * §8 filtering is an explicit allow-list — there is no generic filter DSL here,
 * because handing the client a query language is handing it an exfiltration
 * primitive. Every parameter below is named, parsed and range-checked.
 *
 * Only PUBLISHED and SOLD_OUT rows are ever visible. SOLD_OUT stays in the
 * result set on purpose (§1): a customer who can see that the route exists but
 * has no seats converts into a Request-to-Book, whereas an empty page is a
 * dead end.
 */

const PUBLIC_STATUSES = [LISTING_STATUS.PUBLISHED, LISTING_STATUS.SOLD_OUT]

/** Cheapest room that actually has a price loaded — drives "from £x". */
const cheapestRoom = (rooms: { sellPrice?: Money }[]) =>
   rooms
      .filter((r) => (r.sellPrice?.USD ?? 0) > 0)
      .sort((a, b) => (a.sellPrice!.USD ?? 0) - (b.sellPrice!.USD ?? 0))[0]

/** Escapes a user string before it reaches a $regex. */
const rx = (value: string) =>
   new RegExp(value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const int = (v: unknown) => {
   const n = Number(v)
   return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/** §8: hard maximum page size. No endpoint returns an unbounded result set. */
const MAX_LIMIT = 60
const clampLimit = (v: unknown) => Math.min(int(v) ?? 24, MAX_LIMIT)

/**
 * Sorting always runs on the USD price. It is the reporting base and the only
 * currency guaranteed to be set on every record, so a catalogue priced in USD
 * and CDF still sorts consistently for a visitor viewing euros.
 */
const SORTS: Record<string, Record<string, 1 | -1>> = {
   price_asc: { 'sellPrice.USD': 1 },
   price_desc: { 'sellPrice.USD': -1 },
   rating: { rating: -1, 'sellPrice.USD': 1 },
   departure: { 'attributes.departsAt': 1, validUntil: 1 },
   recommended: { rating: -1, 'sellPrice.USD': 1 },
}

/**
 * GET /api/v1/listings
 * Allow-listed params: vertical, city, origin, destination, cabin, tripType,
 * propertyType, operator, category, transmission, withDriver, bedrooms,
 * minPrice, maxPrice, sort, limit, cursor.
 */
export const searchListings = catchAsync(async (req: Request, res: Response) => {
   const q = req.query
   const vertical = str(q.vertical)
   const filter: Record<string, any> = { status: { $in: PUBLIC_STATUSES } }

   if (vertical) {
      if (!Object.values(VERTICALS).includes(vertical as any)) {
         throw new AppError('Unknown vertical', 400)
      }
      filter.vertical = vertical
   }

   if (str(q.city)) filter.city = rx(str(q.city)!)

   // Origin matches the departure city or the first segment's IATA code;
   // destination matches any segment destination, bus stop, or the title.
   if (str(q.origin)) {
      const value = rx(str(q.origin)!)
      filter.$and = [
         ...(filter.$and ?? []),
         { $or: [{ city: value }, { 'attributes.segments.origin': value }] },
      ]
   }
   if (str(q.destination)) {
      const value = rx(str(q.destination)!)
      filter.$and = [
         ...(filter.$and ?? []),
         {
            $or: [
               { city: value },
               { title: value },
               { 'attributes.segments.destination': value },
               { 'attributes.routeStops': value },
            ],
         },
      ]
   }

   if (str(q.cabin)) filter['attributes.cabin'] = str(q.cabin)
   if (str(q.tripType)) filter['attributes.tripType'] = str(q.tripType)
   if (str(q.propertyType)) filter['attributes.propertyType'] = str(q.propertyType)
   if (str(q.transmission)) filter['attributes.transmission'] = str(q.transmission)
   if (str(q.withDriver)) filter['attributes.withDriver'] = str(q.withDriver) === 'true'
   if (int(q.bedrooms)) filter['attributes.bedrooms'] = { $gte: int(q.bedrooms) }

   // Cars call it `category`, buses `vehicleClass`; one param covers both so the
   // filter sidebar does not need a per-vertical key.
   if (str(q.category)) {
      filter.$and = [
         ...(filter.$and ?? []),
         {
            $or: [
               { 'attributes.category': str(q.category) },
               { 'attributes.vehicleClass': str(q.category) },
            ],
         },
      ]
   }
   // Bus stores the carrier as `operator`; flights store it per segment.
   if (str(q.operator)) {
      filter.$and = [
         ...(filter.$and ?? []),
         {
            $or: [
               { 'attributes.operator': str(q.operator) },
               { 'attributes.segments.carrier': str(q.operator) },
            ],
         },
      ]
   }

   const min = int(q.minPrice)
   const max = int(q.maxPrice)
   if (min !== undefined || max !== undefined) {
      filter['sellPrice.USD'] = {
         ...(min !== undefined ? { $gte: min } : {}),
         ...(max !== undefined ? { $lte: max } : {}),
      }
   }

   const limit = clampLimit(q.limit)
   const sort = SORTS[str(q.sort) ?? 'recommended'] ?? SORTS.recommended

   const [docs, total] = await Promise.all([
      Listing.find(filter).sort(sort).limit(limit).lean({ virtuals: false }),
      Listing.countDocuments(filter),
   ])

   // "Recommended" puts anything still in stock above anything sold out. Doing
   // it here rather than in Mongo keeps the sort explainable; the page size is
   // capped at 60 so the cost is irrelevant.
   const items = presentListings(docs as any)
   if ((str(q.sort) ?? 'recommended') === 'recommended') {
      items.sort((a: any, b: any) => Number(b.available > 0) - Number(a.available > 0))
   }

   sendResponse(res, 200, 'Listings', { items, total, limit })
})

/** GET /api/v1/listings/:slug */
export const getListing = catchAsync(async (req: Request, res: Response) => {
   const listing = await Listing.findOne({
      slug: String(req.params.slug).toLowerCase(),
      status: { $in: PUBLIC_STATUSES },
   }).lean({ virtuals: false })

   if (!listing) throw new AppError('Listing not found', 404)

   const related = await Listing.find({
      vertical: (listing as any).vertical,
      _id: { $ne: (listing as any)._id },
      status: LISTING_STATUS.PUBLISHED,
   })
      .sort({ rating: -1 })
      .limit(4)
      .lean({ virtuals: false })

   sendResponse(res, 200, 'Listing', {
      listing: presentListing(listing as any),
      related: presentListings(related as any),
   })
})

/* ------------------------------------------------------------------- hotels */

/**
 * Resolves nightly price and availability for a set of room types over a date
 * range. One aggregation for the whole hotel rather than a query per room —
 * the N+1 version was the first thing that would fall over on a 3G connection.
 */
async function priceRoomTypes(
   roomTypeIds: any[],
   from?: Date,
   to?: Date
): Promise<Map<string, { sellPrice: Money; available: number; mealPlan: string }>> {
   const match: Record<string, any> = { roomType: { $in: roomTypeIds }, blocked: false }
   if (from && to) match.date = { $gte: from, $lt: to }

   const rows = await RatePlan.aggregate([
      { $match: match },
      {
         $group: {
            _id: '$roomType',
            // The nightly rate the customer sees is the cheapest night in the
            // range; availability is the tightest night, because a stay needs
            // every night of it. Each currency is minimised independently —
            // taking $min of the whole sub-document would compare objects.
            usd: { $min: '$sellPrice.USD' },
            cdf: { $min: '$sellPrice.CDF' },
            eur: { $min: '$sellPrice.EUR' },
            available: { $min: { $subtract: ['$allotment', { $add: ['$sold', '$held'] }] } },
            mealPlan: { $first: '$mealPlan' },
            nights: { $sum: 1 },
         },
      },
   ])

   const nightsNeeded =
      from && to ? Math.max(1, Math.round((+to - +from) / 86400000)) : undefined

   return new Map(
      rows.map((r: any) => [
         String(r._id),
         {
            sellPrice: asMoney(r),
            // A room with no rate loaded for one of the nights is not bookable
            // for that stay, however much allotment the other nights have.
            available:
               nightsNeeded && r.nights < nightsNeeded ? 0 : Math.max(r.available ?? 0, 0),
            mealPlan: r.mealPlan ?? 'ROOM_ONLY',
         },
      ])
   )
}

/** Aggregation row → Money, dropping currencies with no price loaded. */
const asMoney = (r: { usd?: number; cdf?: number; eur?: number }): Money => {
   const out: Money = { USD: r.usd ?? 0 }
   if (typeof r.cdf === 'number' && r.cdf > 0) out.CDF = r.cdf
   if (typeof r.eur === 'number' && r.eur > 0) out.EUR = r.eur
   return out
}

/** The base-currency amount, which is what sorting and filtering compare. */
const base = (m: Money | number | undefined) =>
   typeof m === 'number' ? m : (m?.USD ?? 0)

const parseDate = (v: unknown) => {
   const s = str(v)
   if (!s) return undefined
   const d = new Date(`${s}T00:00:00.000Z`)
   return Number.isNaN(+d) ? undefined : d
}

/** GET /api/v1/hotels */
export const searchHotels = catchAsync(async (req: Request, res: Response) => {
   const q = req.query
   const filter: Record<string, any> = { status: { $in: PUBLIC_STATUSES } }

   if (str(q.city)) filter.city = rx(str(q.city)!)
   if (str(q.destination)) {
      const value = rx(str(q.destination)!)
      filter.$or = [{ city: value }, { name: value }, { address: value }]
   }
   const stars = str(q.stars)
      ?.split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n))
   if (stars?.length) filter.stars = { $in: stars }

   const amenities = str(q.amenities)?.split(',').filter(Boolean)
   if (amenities?.length) filter.amenities = { $all: amenities }

   const from = parseDate(q.from)
   const to = parseDate(q.to)
   const limit = clampLimit(q.limit)

   const hotels = await Hotel.find(filter).limit(limit).lean({ virtuals: false })
   const hotelIds = hotels.map((h: any) => h._id)

   const rooms = await RoomType.find({
      hotel: { $in: hotelIds },
      status: LISTING_STATUS.PUBLISHED,
   }).lean({ virtuals: false })

   const prices = await priceRoomTypes(
      rooms.map((r: any) => r._id),
      from,
      to
   )

   const withPrice: HotelWithRooms[] = hotels.map((h: any) => {
      const mine = rooms.filter((r: any) => String(r.hotel) === String(h._id))
      const priced = mine.map((r: any) => ({
         ...r,
         ...(prices.get(String(r._id)) ?? { sellPrice: 0, available: 0 }),
      })) as RoomTypeWithPrice[]
      const cheapest = cheapestRoom(priced)
      return {
         ...h,
         roomTypes: priced,
         fromPrice: cheapest?.sellPrice ?? { USD: 0 },
      } as HotelWithRooms
   })

   const min = int(q.minPrice)
   const max = int(q.maxPrice)
   let items = withPrice.filter(
      (h) =>
         (min === undefined || base(h.fromPrice) >= min) &&
         (max === undefined || base(h.fromPrice) <= max)
   )

   const sort = str(q.sort) ?? 'recommended'
   items = items.sort((a, b) => {
      if (sort === 'price_asc') return base(a.fromPrice) - base(b.fromPrice)
      if (sort === 'price_desc') return base(b.fromPrice) - base(a.fromPrice)
      return ((b as any).rating ?? 0) - ((a as any).rating ?? 0)
   })

   sendResponse(res, 200, 'Hotels', {
      items: presentHotels(items),
      total: items.length,
      limit,
   })
})

/** GET /api/v1/hotels/:slug */
export const getHotel = catchAsync(async (req: Request, res: Response) => {
   const hotel = await Hotel.findOne({
      slug: String(req.params.slug).toLowerCase(),
      status: { $in: PUBLIC_STATUSES },
   }).lean({ virtuals: false })
   if (!hotel) throw new AppError('Hotel not found', 404)

   const rooms = await RoomType.find({
      hotel: (hotel as any)._id,
      status: LISTING_STATUS.PUBLISHED,
   }).lean({ virtuals: false })

   const prices = await priceRoomTypes(
      rooms.map((r: any) => r._id),
      parseDate(req.query.from),
      parseDate(req.query.to)
   )

   const priced = rooms.map((r: any) => ({
      ...r,
      ...(prices.get(String(r._id)) ?? { sellPrice: { USD: 0 }, available: 0 }),
   })) as RoomTypeWithPrice[]

   const others = await Hotel.find({
      _id: { $ne: (hotel as any)._id },
      status: LISTING_STATUS.PUBLISHED,
   })
      .sort({ rating: -1 })
      .limit(4)
      .lean({ virtuals: false })

   /**
    * `fromPrice` is computed from room rates, not stored on the hotel — so raw
    * documents carry none, and `presentHotels` was emitting `{ USD: 0 }` for
    * every related hotel. The card renders that as "from $0", which on the one
    * surface whose entire job is the price is worse than showing nothing.
    *
    * Same two queries the list endpoint already does, for four documents.
    */
   const otherRooms = await RoomType.find({
      hotel: { $in: others.map((h: any) => h._id) },
      status: LISTING_STATUS.PUBLISHED,
   }).lean({ virtuals: false })

   const otherPrices = await priceRoomTypes(
      otherRooms.map((r: any) => r._id),
      parseDate(req.query.from),
      parseDate(req.query.to)
   )

   const othersWithPrice = others.map((h: any) => {
      const mine = otherRooms
         .filter((r: any) => String(r.hotel) === String(h._id))
         .map((r: any) => ({
            ...r,
            ...(otherPrices.get(String(r._id)) ?? { sellPrice: { USD: 0 }, available: 0 }),
         })) as RoomTypeWithPrice[]
      return { ...h, roomTypes: mine, fromPrice: cheapestRoom(mine)?.sellPrice ?? { USD: 0 } }
   })

   sendResponse(res, 200, 'Hotel', {
      hotel: presentHotel({
         ...(hotel as any),
         roomTypes: priced,
         fromPrice: cheapestRoom(priced)?.sellPrice ?? { USD: 0 },
      }),
      others: presentHotels(othersWithPrice as any),
   })
})

/* ------------------------------------------------------------------- facets */

/**
 * GET /api/v1/catalogue/facets
 * Filter options derived from what is actually on sale. A sidebar listing an
 * airline we no longer sell is worse than no sidebar.
 */
export const getFacets = catchAsync(async (_req: Request, res: Response) => {
   const [cities, carriers, operators, categories, vehicleClasses, hotelAmenities, ranges] =
      await Promise.all([
         Listing.distinct('city', { status: { $in: PUBLIC_STATUSES } }),
         Listing.distinct('attributes.segments.carrier', { vertical: VERTICALS.FLIGHT }),
         Listing.distinct('attributes.operator', { vertical: VERTICALS.BUS }),
         Listing.distinct('attributes.category', { vertical: VERTICALS.CAR }),
         Listing.distinct('attributes.vehicleClass', { vertical: VERTICALS.BUS }),
         Hotel.distinct('amenities', { status: { $in: PUBLIC_STATUSES } }),
         Listing.aggregate([
            { $match: { status: { $in: PUBLIC_STATUSES } } },
            {
               $group: {
                  _id: '$vertical',
                  min: { $min: '$sellPrice.USD' },
                  max: { $max: '$sellPrice.USD' },
               },
            },
         ]),
      ])

   const priceBounds: Record<string, [number, number]> = {}
   for (const r of ranges as any[]) priceBounds[r._id] = [r.min ?? 0, r.max ?? 0]

   const hotelBounds = await Hotel.aggregate([
      { $match: { status: { $in: PUBLIC_STATUSES } } },
      { $lookup: { from: 'roomtypes', localField: '_id', foreignField: 'hotel', as: 'rt' } },
      { $unwind: '$rt' },
      { $lookup: { from: 'rateplans', localField: 'rt._id', foreignField: 'roomType', as: 'rp' } },
      { $unwind: '$rp' },
      {
         $group: {
            _id: null,
            min: { $min: '$rp.sellPrice.USD' },
            max: { $max: '$rp.sellPrice.USD' },
         },
      },
   ])
   priceBounds.HOTEL = [hotelBounds[0]?.min ?? 0, hotelBounds[0]?.max ?? 100000]

   sendResponse(res, 200, 'Facets', {
      cities: (cities as string[]).filter(Boolean).sort(),
      carriers: (carriers as string[]).filter(Boolean).sort(),
      operators: (operators as string[]).filter(Boolean).sort(),
      categories: (categories as string[]).filter(Boolean).sort(),
      vehicleClasses: (vehicleClasses as string[]).filter(Boolean).sort(),
      hotelAmenities: (hotelAmenities as string[]).filter(Boolean).sort(),
      priceBounds,
   })
})

/**
 * GET /api/v1/catalogue/home
 * One request for the homepage rails, so a phone on 3G makes one round trip
 * instead of four.
 */
export const getHomeFeed = catchAsync(async (_req: Request, res: Response) => {
   /**
    * Two of each sellable vertical rather than the eight highest-rated overall.
    * Sorting the whole catalogue by rating put eight 4.9s on the homepage, all
    * flights and buses — which reads as fake and shows none of the range.
    */
   const SELLABLE = [
      VERTICALS.FLIGHT,
      VERTICALS.HOTEL,
      VERTICALS.BUS,
      VERTICALS.CAR,
      VERTICALS.ACTIVITY,
   ].filter((v) => v !== VERTICALS.HOTEL)

   const [dealsByVertical, properties, hotels] = await Promise.all([
      Promise.all(
         SELLABLE.map((vertical) =>
            Listing.find({
               status: LISTING_STATUS.PUBLISHED,
               vertical,
               $expr: { $gt: [{ $subtract: ['$quantityTotal', '$quantitySold'] }, 0] },
            })
               .sort({ rating: -1, 'sellPrice.USD': 1 })
               .limit(2)
               .lean({ virtuals: false })
         )
      ),
      Listing.find({ status: LISTING_STATUS.PUBLISHED, vertical: VERTICALS.PROPERTY })
         .sort({ createdAt: -1 })
         .limit(4)
         .lean({ virtuals: false }),
      Hotel.find({ status: LISTING_STATUS.PUBLISHED })
         .sort({ rating: -1 })
         .limit(4)
         .lean({ virtuals: false }),
   ])

   const rooms = await RoomType.find({
      hotel: { $in: hotels.map((h: any) => h._id) },
      status: LISTING_STATUS.PUBLISHED,
   }).lean({ virtuals: false })
   const prices = await priceRoomTypes(rooms.map((r: any) => r._id))

   const hotelsWithPrice: HotelWithRooms[] = hotels.map((h: any) => {
      const mine = rooms
         .filter((r: any) => String(r.hotel) === String(h._id))
         .map((r: any) => ({ ...r, ...(prices.get(String(r._id)) ?? {}) }))
      return {
         ...h,
         roomTypes: mine,
         fromPrice: cheapestRoom(mine as any)?.sellPrice ?? { USD: 0 },
      } as HotelWithRooms
   })

   // Interleave so the rail alternates verticals instead of grouping them.
   const deals: any[] = []
   for (let i = 0; i < 2; i++) {
      for (const group of dealsByVertical) if (group[i]) deals.push(group[i])
   }

   sendResponse(res, 200, 'Home feed', {
      deals: presentListings(deals as any),
      properties: presentListings(properties as any),
      hotels: presentHotels(hotelsWithPrice),
   })
})

/** GET /api/v1/catalogue/slugs — used by the frontend to pre-render pages. */
export const getSlugs = catchAsync(async (_req: Request, res: Response) => {
   const [listings, hotels] = await Promise.all([
      Listing.find({ status: { $in: PUBLIC_STATUSES } })
         .select('slug vertical')
         .lean(),
      Hotel.find({ status: { $in: PUBLIC_STATUSES } })
         .select('slug')
         .lean(),
   ])
   sendResponse(res, 200, 'Slugs', {
      listings: (listings as any[]).map((l) => ({ slug: l.slug, vertical: l.vertical })),
      hotels: (hotels as any[]).map((h) => h.slug),
   })
})
