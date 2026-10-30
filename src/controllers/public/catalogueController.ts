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
import { baseAmount, Money } from '../../model/shared.schema'
import { isScheduledRoute, Listing, livePromotionClauses } from '../../model/listingModel'
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

/** Cheapest room that actually has a price loaded — drives "from x FC". */
const cheapestRoom = (rooms: { sellPrice?: Money }[]) =>
   rooms
      .filter((r) => baseAmount(r.sellPrice) > 0)
      .sort((a, b) => baseAmount(a.sellPrice) - baseAmount(b.sellPrice))[0]

/** Escapes a user string before it reaches a $regex. */
const rx = (value: string) =>
   // A NUL byte cannot be sent to MongoDB in a regex (the driver throws),
   // and no name contains one.
   new RegExp(value.replace(/\0/g, '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
/** Free-text search box: capped so a pasted paragraph never becomes a regex. */
const term = (v: unknown) => str(v)?.slice(0, 80)
/** A whole number from a query param. Blank is absent: `?limit=` is not 0. */
const int = (v: unknown) => {
   const n = Number(str(v))
   return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/** §8: hard maximum page size. No endpoint returns an unbounded result set. */
const MAX_LIMIT = 60
/** §8 paging: `limit` 1–60 (24 when absent; 0 is not "no limit") and `page` 1–1000. */
export const pageOf = (q: Request['query']) => {
   const limit = Math.min(Math.max(int(q.limit) ?? 24, 1), MAX_LIMIT)
   const page = Math.min(Math.max(int(q.page) ?? 1, 1), 1000)
   return { limit, page, skip: (page - 1) * limit }
}
/** What a search answers besides its items. `pages` is 0 when nothing matches. */
export const pageInfo = (total: number, { limit, page }: { limit: number; page: number }) => ({
   total,
   limit,
   page,
   pages: Math.ceil(total / limit),
})
/**
 * Searches ordered in memory read at most this many matches.
 * ponytail: past it the tail is unreachable; order in an aggregate then.
 */
const IN_MEMORY_MAX = 1000

/**
 * Sorting always runs on the franc price. It is the base and the only currency
 * stored on every record (USD and EUR are worked out from it), so the order is
 * the same whichever currency the visitor views. `_id` breaks ties, so a
 * listing never shows on two pages, or on none.
 */
const SORTS: Record<string, Record<string, 1 | -1>> = {
   price_asc: { 'sellPrice.CDF': 1, _id: 1 },
   price_desc: { 'sellPrice.CDF': -1, _id: 1 },
   // Customers' approved reviews only, never the legacy `rating` (see the DTO).
   rating: { 'reviewStats.rating': -1, 'sellPrice.CDF': 1, _id: 1 },
   departure: { 'attributes.departsAt': 1, validUntil: 1, _id: 1 },
   recommended: { 'reviewStats.rating': -1, 'sellPrice.CDF': 1, _id: 1 },
}

/** Still bookable: routes and properties have no stock count; anything else must have some left. */
const inStock = (l: any) =>
   isScheduledRoute(l.vertical) ||
   l.vertical === VERTICALS.PROPERTY ||
   (l.quantityTotal ?? 0) - (l.quantitySold ?? 0) - (l.quantityHeld ?? 0) > 0

/** `inStock` as a query: units left once sold and held (unpaid cash orders) ones are taken off. */
const STOCK_LEFT = {
   $expr: {
      $gt: [
         {
            $subtract: [
               '$quantityTotal',
               { $add: [{ $ifNull: ['$quantitySold', 0] }, { $ifNull: ['$quantityHeld', 0] }] },
            ],
         },
         0,
      ],
   },
}

/** A route's first departure that day — or, with no day asked, any day. */
const firstDeparture = (a: any, day?: string) =>
   (day
      ? timesOn(a, day)
      : [...(a?.dailyTimes ?? []), ...(a?.weeklyTimes ?? []).map((w: any) => w.time)].sort())[0] ??
   '99:99'

/**
 * One page of the matches in an order worked out here: `rank` first, then
 * Mongo's order (Array.sort is stable). Every match is ranked on the few
 * fields the order needs, and only the page is read whole.
 */
const rankedPage = async (
   filter: Record<string, any>,
   sort: Record<string, 1 | -1>,
   rank: (l: any) => number | string,
   { skip, limit }: { skip: number; limit: number }
) => {
   const keys = await Listing.find(filter)
      .sort(sort)
      .limit(IN_MEMORY_MAX)
      .select('vertical quantityTotal quantitySold quantityHeld attributes.dailyTimes attributes.weeklyTimes')
      .lean({ virtuals: false })
   const ids = keys
      .map((l: any) => ({ id: String(l._id), by: rank(l) }))
      .sort((a, b) => (a.by < b.by ? -1 : a.by > b.by ? 1 : 0))
      .slice(skip, skip + limit)
      .map((k) => k.id)
   const docs = await Listing.find({ _id: { $in: ids } }).lean({ virtuals: false })
   return docs.sort((a: any, b: any) => ids.indexOf(String(a._id)) - ids.indexOf(String(b._id)))
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
 * propertyType, operator, category, make, transmission, withDriver, bedrooms,
 * minPrice, maxPrice, promo, sort, page, limit.
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
   // A car's make, one of the facet's: the whole name in any case, as it was
   // typed ("toyota ") — the facet offers each make once, whatever its spelling.
   if (term(q.make)) filter['attributes.make'] = new RegExp(`^\\s*${rx(term(q.make)!).source}\\s*$`, 'i')
   if (int(q.bedrooms)) filter['attributes.bedrooms'] = { $gte: int(q.bedrooms) }

   // Cars call it `category`, buses `vehicleClass`; one param covers both so the
   // filter sidebar does not need a per-vertical key. In any case, like `make`:
   // a car typed "Berline" before the type list is the code BERLINE (the CSV
   // import reads it so too), and the type chips send the code.
   if (term(q.category)) {
      const value = new RegExp(`^\\s*${rx(term(q.category)!).source}\\s*$`, 'i')
      filter.$and = [
         ...(filter.$and ?? []),
         {
            $or: [
               { 'attributes.category': value },
               { 'attributes.vehicleClass': value },
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

   // In francs, like the stored price.
   const min = int(q.minPrice)
   const max = int(q.maxPrice)
   if (min !== undefined || max !== undefined) {
      filter['sellPrice.CDF'] = {
         ...(min !== undefined ? { $gte: min } : {}),
         ...(max !== undefined ? { $lte: max } : {}),
      }
   }

   // The promotions page: only offers whose promotion is running (display only).
   if (str(q.promo) === 'true') filter.$and = [...(filter.$and ?? []), ...livePromotionClauses()]

   const paging = pageOf(q)
   // Own keys only: `?sort=constructor` is not a sort.
   const sortKey = Object.hasOwn(SORTS, str(q.sort) ?? '') ? str(q.sort)! : 'recommended'
   const sort = SORTS[sortKey]
   // Two orders are not stored fields, so every match is ranked before the
   // page is cut, and the order holds across pages: "recommended" puts
   // anything still in stock above anything sold out (routes and properties
   // have no stock, so their searches keep Mongo's order), and a route's
   // "departure" is its first time.
   const rank =
      route && sortKey === 'departure'
         ? (l: any) => firstDeparture(l.attributes, day)
         : !route && sortKey === 'recommended'
           ? (l: any) => (inStock(l) ? 0 : 1)
           : undefined

   const [docs, total] = await Promise.all([
      rank
         ? rankedPage(filter, sort, rank, paging)
         : Listing.find(filter).sort(sort).skip(paging.skip).limit(paging.limit).lean({ virtuals: false }),
      Listing.countDocuments(filter),
   ])

   sendResponse(res, 200, 'Listings', { items: presentListings(docs as any), ...pageInfo(total, paging) })
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
      .sort({ 'reviewStats.rating': -1 })
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
   return { ...h, roomTypes: mine, fromPrice: cheapestRoom(mine)?.sellPrice ?? { CDF: 0 } }
}

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

   const { limit, page, skip } = pageOf(q)

   // Every match, then the page: the price filter and the sorts read the
   // "from" price, worked out from the rooms, so the page is cut once all of
   // them are priced, and the total counts what the filter kept. In _id order
   // first, so equals stay in one order (the sort below is stable).
   const hotels = await Hotel.find(filter).sort({ _id: 1 }).limit(IN_MEMORY_MAX).lean({ virtuals: false })
   const rooms = await roomsOf(hotels.map((h: any) => h._id))
   const withPrice = hotels.map((h: any) => withRooms(h, rooms))

   const min = int(q.minPrice)
   const max = int(q.maxPrice)
   let items = withPrice.filter(
      (h) =>
         (min === undefined || baseAmount(h.fromPrice) >= min) &&
         (max === undefined || baseAmount(h.fromPrice) <= max)
   )

   const sort = str(q.sort) ?? 'recommended'
   items = items.sort((a, b) => {
      if (sort === 'price_asc') return baseAmount(a.fromPrice) - baseAmount(b.fromPrice)
      if (sort === 'price_desc') return baseAmount(b.fromPrice) - baseAmount(a.fromPrice)
      return (b.reviewStats?.rating ?? 0) - (a.reviewStats?.rating ?? 0)
   })

   sendResponse(res, 200, 'Hotels', {
      items: presentHotels(items.slice(skip, skip + limit)),
      ...pageInfo(items.length, { limit, page }),
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
      .sort({ 'reviewStats.rating': -1 })
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
   const [cities, carriers, operators, categories, vehicleClasses, hotelAmenities, ranges, makes] =
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
                  min: { $min: '$sellPrice.CDF' },
                  max: { $max: '$sellPrice.CDF' },
               },
            },
         ]),
         Listing.distinct('attributes.make', { vertical: VERTICALS.CAR, status: { $in: PUBLIC_STATUSES } }),
      ])

   const priceBounds: Record<string, [number, number]> = {}
   for (const r of ranges as any[]) priceBounds[r._id] = [r.min ?? 0, r.max ?? 0]

   const hotelBounds = await Hotel.aggregate([
      { $match: { status: { $in: PUBLIC_STATUSES } } },
      { $lookup: { from: 'roomtypes', localField: '_id', foreignField: 'hotel', as: 'rt' } },
      { $unwind: '$rt' },
      { $match: { 'rt.status': LISTING_STATUS.PUBLISHED, 'rt.sellPrice.CDF': { $gt: 0 } } },
      {
         $group: {
            _id: null,
            min: { $min: '$rt.sellPrice.CDF' },
            max: { $max: '$rt.sellPrice.CDF' },
         },
      },
   ])
   // Francs; with no priced room, a ceiling of about $1 000.
   priceBounds.HOTEL = [hotelBounds[0]?.min ?? 0, hotelBounds[0]?.max ?? 2_850_000]

   sendResponse(res, 200, 'Facets', {
      cities: (cities as string[]).filter(Boolean).sort(),
      carriers: (carriers as string[]).filter(Boolean).sort(),
      operators: (operators as string[]).filter(Boolean).sort(),
      categories: (categories as string[]).filter(Boolean).sort(),
      vehicleClasses: (vehicleClasses as string[]).filter(Boolean).sort(),
      hotelAmenities: (hotelAmenities as string[]).filter(Boolean).sort(),
      // Each make once, however it was typed ("Toyota", "toyota "): `make` finds them all.
      makes: [
         ...new Map(
            (makes as unknown[])
               .filter((m): m is string => typeof m === 'string' && Boolean(m.trim()))
               .map((m) => [m.trim().toLowerCase(), m.trim()])
         ).values(),
      ].sort(),
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

   const [dealsByVertical, properties, hotels, promotions] = await Promise.all([
      Promise.all(
         SELLABLE.map((vertical) =>
            Listing.find({
               status: LISTING_STATUS.PUBLISHED,
               vertical,
               // A route has no seat count; anything else must have stock left.
               ...(isScheduledRoute(vertical)
                  ? {}
                  : STOCK_LEFT),
            })
               .sort({ 'reviewStats.rating': -1, 'sellPrice.CDF': 1 })
               .limit(2)
               .lean({ virtuals: false })
         )
      ),
      Listing.find({ status: LISTING_STATUS.PUBLISHED, vertical: VERTICALS.PROPERTY })
         .sort({ createdAt: -1 })
         .limit(4)
         .lean({ virtuals: false }),
      Hotel.find({ status: LISTING_STATUS.PUBLISHED })
         .sort({ 'reviewStats.rating': -1 })
         .limit(4)
         .lean({ virtuals: false }),
      // Running promotions, the biggest discount first (the smallest share of
      // the old price left to pay). Like the deals: some stock left, unless
      // it is a route or a property, which have no count.
      Listing.aggregate([
         {
            $match: {
               status: LISTING_STATUS.PUBLISHED,
               $and: [
                  ...livePromotionClauses(),
                  {
                     $or: [
                        { vertical: { $in: [VERTICALS.BUS, VERTICALS.FLIGHT, VERTICALS.PROPERTY] } },
                        STOCK_LEFT,
                     ],
                  },
               ],
            },
         },
         { $addFields: { share: { $divide: ['$sellPrice.CDF', '$promoCompareAtPrice.CDF'] } } },
         { $sort: { share: 1, _id: 1 } },
         { $limit: 12 },
      ]),
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
      promotions: presentListings(promotions as any),
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
