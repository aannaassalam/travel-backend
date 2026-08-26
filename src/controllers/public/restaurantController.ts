import { Request, Response } from 'express'
import { LISTING_STATUS, MENU_SECTIONS } from '../../constants/domain.constants'
import { presentRestaurant, presentRestaurants } from '../../dto/public/catalogue.dto'
import { MenuItem, Restaurant } from '../../model/restaurantModel'
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
      { $group: { _id: '$restaurant', usd: { $min: '$sellPrice.USD' } } },
   ])
   return new Map(rows.map((r: any) => [String(r._id), { USD: r.usd ?? 0 }]))
}

/**
 * GET /api/v1/restaurants?city=Kinshasa&cuisine=Congolais&sort=price_asc
 */
export const searchRestaurants = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, unknown> = { status: PUBLIC_STATUS }

   const city = String(req.query.city ?? req.query.destination ?? '').trim()
   // Anchored, case-insensitive, and escaped: an unescaped query string reaching
   // a RegExp lets a caller post `.*` — or something far more expensive — and
   // have the database evaluate it.
   if (city) filter.city = new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')

   const cuisine = String(req.query.cuisine ?? '').trim()
   if (cuisine) filter.cuisines = cuisine

   const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 60)

   const sort: Record<string, 1 | -1> =
      req.query.sort === 'rating' ? { rating: -1 } : { rating: -1, createdAt: -1 }

   const [items, total] = await Promise.all([
      Restaurant.find(filter).sort(sort).limit(limit),
      Restaurant.countDocuments(filter),
   ])

   const prices = await fromPrices(items.map((r) => r._id))
   const withPrice = items.map((r) => {
      const doc = r.toObject() as any
      doc.fromPrice = prices.get(String(r._id)) ?? { USD: 0 }
      return doc
   })

   return sendResponse(res, 200, 'Restaurants', {
      items: presentRestaurants(withPrice),
      total,
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
      USD: 0,
   }

   return sendResponse(res, 200, 'Restaurant', { restaurant: presentRestaurant(doc) })
})
