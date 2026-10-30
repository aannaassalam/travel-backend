import { LISTING_STATUS } from '../constants/domain.constants'
import { bestPromoted, livePromotionClauses } from '../model/listingModel'
import { IMenuItem, MenuItem } from '../model/restaurantModel'

/**
 * What a restaurant card shows besides the restaurant itself: its "from"
 * price and its best dish promotion. Shared by the restaurant search and the
 * home feed, which is why it is not in either controller.
 */

const PUBLIC_STATUS = LISTING_STATUS.PUBLISHED

/**
 * The cheapest published dish, which is what the card shows as "from".
 *
 * Read across the whole page of restaurants in one aggregate rather than one
 * query per card — the alternative is N+1 on a list that is meant to be the
 * fastest page on the site (§11.7 budgets it for 3G).
 */
export const fromPrices = async (ids: any[]) => {
   const rows = await MenuItem.aggregate([
      { $match: { restaurant: { $in: ids }, status: PUBLIC_STATUS, isAvailable: true } },
      { $group: { _id: '$restaurant', cdf: { $min: '$sellPrice.CDF' } } },
   ])
   return new Map(rows.map((r: any) => [String(r._id), { CDF: r.cdf ?? 0 }]))
}

/** Available dishes on a running promotion (display only). */
export const promotedDish = () => ({
   status: PUBLIC_STATUS,
   isAvailable: true,
   $and: livePromotionClauses(),
})

/** Per restaurant, its available dish with the best running promotion. */
const promotedDishes = async (ids: any[]) => {
   const dishes = (await MenuItem.find({ restaurant: { $in: ids }, ...promotedDish() }).lean({
      virtuals: false,
   })) as IMenuItem[]
   const byRestaurant = new Map<string, IMenuItem[]>()
   for (const d of dishes) {
      const key = String(d.restaurant)
      byRestaurant.set(key, [...(byRestaurant.get(key) ?? []), d])
   }
   return new Map([...byRestaurant].map(([key, list]) => [key, bestPromoted(list)]))
}

/**
 * What the cards of these restaurants show, read in one round: a function that
 * adds `fromPrice` and `promoItem` to a plain restaurant document. Needs only
 * the ids, so it can run alongside the read of the restaurants themselves.
 */
export const cardPricesFor = async (ids: any[]) => {
   const [prices, promoted] = await Promise.all([fromPrices(ids), promotedDishes(ids)])
   return (r: any) => ({
      ...r,
      fromPrice: prices.get(String(r._id)) ?? { CDF: 0 },
      promoItem: promoted.get(String(r._id)),
   })
}

/** Plain restaurant documents with what their cards show: `fromPrice` and `promoItem`. */
export const withCardPrices = async (docs: any[]) => docs.map(await cardPricesFor(docs.map((r) => r._id)))
