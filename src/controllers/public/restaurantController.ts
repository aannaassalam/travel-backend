import { Request, Response } from 'express'
import { LISTING_STATUS, LOCALES, MENU_SECTIONS } from '../../constants/domain.constants'
import { presentRestaurant, presentRestaurants } from '../../dto/public/catalogue.dto'
import { MenuItem, Restaurant } from '../../model/restaurantModel'
import { pageInfo, pageOf } from './catalogueController'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Public restaurant catalogue.
 *
 * Only PUBLISHED records are ever visible. A DRAFT restaurant is one the office
 * is still typing a menu into, and a customer reaching it would see half a menu
 * and prices that are about to change.
 */

const PUBLIC_STATUS = LISTING_STATUS.PUBLISHED

/**
 * Menu order is starters → mains → sides → desserts → drinks, which is the
 * order MENU_SECTIONS declares. Sorting on the enum in Mongo gives alphabetical
 * — DESSERT, DRINK, MAIN — so a menu opens on the puddings. The rank has to be
 * applied here rather than in the query.
 */
const SECTION_RANK = Object.values(MENU_SECTIONS).reduce<Record<string, number>>(
   (acc, s, i) => ({ ...acc, [s]: i }),
   {}
)
const byMenuOrder = (a: any, b: any) =>
   (SECTION_RANK[a.section] ?? 99) - (SECTION_RANK[b.section] ?? 99) ||
   (a.sortOrder ?? 0) - (b.sortOrder ?? 0)

/**
 * The cheapest published dish, which is what the card shows as "from".
 *
 * Read across the whole page of restaurants in one aggregate rather than one
 * query per card — the alternative is N+1 on a list that is meant to be the
 * fastest page on the site (§11.7 budgets it for 3G).
 */
const fromPrices = async (ids: any[]) => {
   const rows = await MenuItem.aggregate([
      { $match: { restaurant: { $in: ids }, status: PUBLIC_STATUS, isAvailable: true } },
      { $group: { _id: '$restaurant', cdf: { $min: '$sellPrice.CDF' } } },
   ])
   return new Map(rows.map((r: any) => [String(r._id), { CDF: r.cdf ?? 0 }]))
}

/**
 * Escaped before it reaches a RegExp: an unescaped query string lets a caller
 * post `.*` — or something far more expensive — and have the database
 * evaluate it.
 */
const escapeRx = (value: string) =>
   value.replace(/\0/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * GET /api/v1/restaurants?q=poisson&city=Kinshasa&cuisine=Congolais&sort=rating&page=2&limit=30
 */
export const searchRestaurants = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, unknown> = { status: PUBLIC_STATUS }

   const city = String(req.query.city ?? req.query.destination ?? '').trim()
   // Anchored and case-insensitive: the city filter is a pick, not a search.
   if (city) filter.city = new RegExp(`^${escapeRx(city)}$`, 'i')

   const cuisine = String(req.query.cuisine ?? '').trim()
   if (cuisine) filter.cuisines = cuisine

   // The search box: a substring of the name in any locale, a cuisine, the
   // address or the city. Capped so a pasted paragraph never becomes a regex.
   const q = String(req.query.q ?? '').trim().slice(0, 80)
   if (q) {
      const value = new RegExp(escapeRx(q), 'i')
      filter.$or = [
         ...LOCALES.map((l) => ({ [`name.${l}`]: value })),
         { cuisines: value },
         { address: value },
         { city: value },
      ]
   }

   const paging = pageOf(req.query)

   const sort: Record<string, 1 | -1> =
      // Customers' approved reviews only, never the legacy `rating`. `_id`
      // breaks ties, so a restaurant never shows on two pages, or on none.
      req.query.sort === 'rating'
         ? { 'reviewStats.rating': -1, _id: -1 }
         : { 'reviewStats.rating': -1, createdAt: -1, _id: -1 }

   const published = { status: PUBLIC_STATUS }
   const [items, total, cities, cuisines] = await Promise.all([
      Restaurant.find(filter).sort(sort).skip(paging.skip).limit(paging.limit),
      Restaurant.countDocuments(filter),
      Restaurant.distinct('city', published),
      Restaurant.distinct('cuisines', published),
   ])

   const prices = await fromPrices(items.map((r) => r._id))
   const withPrice = items.map((r) => {
      const doc = r.toObject() as any
      doc.fromPrice = prices.get(String(r._id)) ?? { CDF: 0 }
      return doc
   })

   const choices = (values: unknown[]) =>
      values.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())).sort()
   return sendResponse(res, 200, 'Restaurants', {
      items: presentRestaurants(withPrice),
      ...pageInfo(total, paging),
      // The city and cuisine choices: every published restaurant's, not this page's.
      facets: { cities: choices(cities), cuisines: choices(cuisines) },
   })
})

/**
 * GET /api/v1/restaurants/:slug
 *
 * Returns the restaurant with its full published menu. Unavailable dishes are
 * included deliberately — the menu shows them greyed rather than silently
 * shorter, so a customer looking for yesterday's dish learns it is 86'd today
 * instead of doubting they ever saw it.
 */
export const getRestaurant = catchAsync(async (req: Request, res: Response, next) => {
   const restaurant = await Restaurant.findOne({
      slug: String(req.params.slug).toLowerCase(),
      status: PUBLIC_STATUS,
   })
   if (!restaurant) return next(new AppError('Restaurant not found', 404))

   const menu = (
      await MenuItem.find({ restaurant: restaurant._id, status: PUBLIC_STATUS })
   ).sort(byMenuOrder)

   const doc = restaurant.toObject() as any
   doc.menu = menu
   doc.fromPrice = (await fromPrices([restaurant._id])).get(String(restaurant._id)) ?? {
      CDF: 0,
   }

   return sendResponse(res, 200, 'Restaurant', { restaurant: presentRestaurant(doc) })
})
