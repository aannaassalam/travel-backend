import { Request, Response } from 'express'
import { LISTING_STATUS, LOCALES, VERTICALS } from '../../constants/domain.constants'
import {
   HotelWithRooms,
   presentHotel,
   presentHotels,
   presentListing,
   presentListings,
} from '../../dto/public/catalogue.dto'
import { Hotel, IRoomType, RoomType } from '../../model/hotelModel'
import { Money } from '../../model/shared.schema'
import { isScheduledRoute, Listing } from '../../model/listingModel'
import { timesOn, weekdayOf } from '../../services/orders/schedule.service'
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
   // A NUL byte cannot be sent to MongoDB in a regex (the driver throws),
   // and no name contains one.
   new RegExp(value.replace(/\0/g, '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
/** Free-text search box: capped so a pasted paragraph never becomes a regex. */
const term = (v: unknown) => str(v)?.slice(0, 80)
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
 * Besides the title and city, the attributes the search box on a listing page
 * looks in: the carrier, the car, the meeting point, the kind of property.
 */
// A flight's carrier lives on its segments, so an airline name matches there.
const SEARCHED_ATTRIBUTES = [
   'operator',
   'destination',
   'segments.carrier',
   'meetingPoint',
   'model',
   'make',
   'propertyType',
]

/**
 * GET /api/v1/listings
 * Allow-listed params: q, vertical, city, origin, destination, cabin, tripType,
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

   // Free text, composed with every filter below rather than replacing them.
   if (term(q.q)) {
      const value = rx(term(q.q)!)
      filter.$and = [
         ...(filter.$and ?? []),
         {
            $or: [
               ...LOCALES.map((l) => ({ [`title.${l}`]: value })),
               { city: value },
               ...SEARCHED_ATTRIBUTES.map((a) => ({ [`attributes.${a}`]: value })),
            ],
         },
      ]
   }

   if (str(q.city)) filter.city = rx(str(q.city)!)

   /**
    * A bus or flight is a route: it leaves from `city` for
    * `attributes.destination`, on the days its timetable runs. Searching one
    * is those three things and nothing looser — a route leaving Kinshasa is
    * not an answer to "going to Kinshasa".
    */
   const route = Boolean(vertical && isScheduledRoute(vertical))
   const day = parseDay(q.from)
   if (route) {
      if (str(q.origin)) filter.city = rx(str(q.origin)!)
      if (str(q.destination)) filter['attributes.destination'] = rx(str(q.destination)!)
      if (day) {
         filter.$and = [
            ...(filter.$and ?? []),
            {
               $or: [
                  { 'attributes.dailyTimes.0': { $exists: true } },
                  { 'attributes.weeklyTimes.day': weekdayOf(day) },
               ],
            },
         ]
      }
   }

   // Origin matches the departure city or the first segment's IATA code;
   // destination matches any segment destination, bus stop, or the title.
   if (!route && str(q.origin)) {
      const value = rx(str(q.origin)!)
      filter.$and = [
         ...(filter.$and ?? []),
         { $or: [{ city: value }, { 'attributes.segments.origin': value }] },
      ]
   }
   if (!route && str(q.destination)) {
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
   // capped at 60 so the cost is irrelevant. A route has no stock count.
   const items = presentListings(docs as any)
   if ((str(q.sort) ?? 'recommended') === 'recommended') {
      const inStock = (l: any) => l.available === undefined || l.available > 0
      items.sort((a: any, b: any) => Number(inStock(b)) - Number(inStock(a)))
   }
   // Routes by their first departure that day — or, with no day asked, any day.
   if (route && str(q.sort) === 'departure') {
      const first = (l: any) =>
         (day ? timesOn(l.attributes, day) : [...(l.attributes.dailyTimes ?? []), ...(l.attributes.weeklyTimes ?? []).map((w: any) => w.time)].sort())[0] ?? '99:99'
      items.sort((a: any, b: any) => first(a).localeCompare(first(b)))
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

/** The live room types of these hotels, each with its own nightly price. */
const roomsOf = (hotelIds: any[]) =>
   RoomType.find({
      hotel: { $in: hotelIds },
      status: LISTING_STATUS.PUBLISHED,
   }).lean({ virtuals: false }) as Promise<IRoomType[]>

/** A hotel with its rooms and its "from" price: the cheapest room per night. */
const withRooms = (h: any, rooms: IRoomType[]): HotelWithRooms => {
   const mine = rooms.filter((r) => String(r.hotel) === String(h._id))
   return { ...h, roomTypes: mine, fromPrice: cheapestRoom(mine)?.sellPrice ?? { USD: 0 } }
}

/** The base-currency amount, which is what sorting and filtering compare. */
const base = (m: Money | number | undefined) =>
   typeof m === 'number' ? m : (m?.USD ?? 0)

/** A YYYY-MM-DD the search sent, or nothing. */
const parseDay = (v: unknown) => {
   const s = str(v)
   return s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(+new Date(s)) ? s : undefined
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
   if (term(q.q)) {
      const value = rx(term(q.q)!)
      filter.$and = [
         {
            $or: [
               ...LOCALES.map((l) => ({ [`name.${l}`]: value })),
               { address: value },
               { city: value },
            ],
         },
      ]
   }
   const stars = str(q.stars)
      ?.split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n))
   if (stars?.length) filter.stars = { $in: stars }

   const amenities = str(q.amenities)?.split(',').filter(Boolean)
   if (amenities?.length) filter.amenities = { $all: amenities }

   const limit = clampLimit(q.limit)

   const hotels = await Hotel.find(filter).limit(limit).lean({ virtuals: false })
   const rooms = await roomsOf(hotels.map((h: any) => h._id))
   const withPrice = hotels.map((h: any) => withRooms(h, rooms))

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

   const rooms = await roomsOf([(hotel as any)._id])

   const others = await Hotel.find({
      _id: { $ne: (hotel as any)._id },
      status: LISTING_STATUS.PUBLISHED,
   })
      .sort({ rating: -1 })
      .limit(4)
      .lean({ virtuals: false })

   /**
    * `fromPrice` is computed from room prices, not stored on the hotel — so raw
    * documents carry none, and a related hotel without it would read "from $0",
    * which on the one surface whose entire job is the price is worse than
    * showing nothing.
    */
   const otherRooms = await roomsOf(others.map((h: any) => h._id))

   sendResponse(res, 200, 'Hotel', {
      hotel: presentHotel(withRooms(hotel, rooms)),
      others: presentHotels(others.map((h: any) => withRooms(h, otherRooms))),
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
         // On sale only: an inactive route's agency is not a choice anyone can book.
         Listing.distinct('attributes.operator', { vertical: VERTICALS.FLIGHT, status: { $in: PUBLIC_STATUSES } }),
         Listing.distinct('attributes.operator', { vertical: VERTICALS.BUS, status: { $in: PUBLIC_STATUSES } }),
         Listing.distinct('attributes.category', { vertical: VERTICALS.CAR, status: { $in: PUBLIC_STATUSES } }),
         Listing.distinct('attributes.vehicleClass', { vertical: VERTICALS.BUS, status: { $in: PUBLIC_STATUSES } }),
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
      { $match: { 'rt.status': LISTING_STATUS.PUBLISHED, 'rt.sellPrice.USD': { $gt: 0 } } },
      {
         $group: {
            _id: null,
            min: { $min: '$rt.sellPrice.USD' },
            max: { $max: '$rt.sellPrice.USD' },
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
               // A route has no seat count; anything else must have stock left.
               ...(isScheduledRoute(vertical)
                  ? {}
                  : { $expr: { $gt: [{ $subtract: ['$quantityTotal', '$quantitySold'] }, 0] } }),
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

   const rooms = await roomsOf(hotels.map((h: any) => h._id))
   const hotelsWithPrice = hotels.map((h: any) => withRooms(h, rooms))

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
