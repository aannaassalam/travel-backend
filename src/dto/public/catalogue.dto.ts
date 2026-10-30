import { VERTICALS } from '../../constants/domain.constants'
import { IHotel, IRoomType } from '../../model/hotelModel'
import {
   IListing,
   isScheduledRoute,
   livePromotion,
   livePromotionOf,
   MAIN_PROMO,
   PromoSlot,
   promoSlotsOf,
   promotionPercent,
} from '../../model/listingModel'
import { IMenuItem, IRestaurant } from '../../model/restaurantModel'
import { baseAmount, geoPoint, Localized, Money } from '../../model/shared.schema'
import { inAllCurrencies } from '../../services/fx.service'
import { carRates } from '../../services/orders/rental.service'
import { FieldMap, present, presentList } from '../../utils/present'

/** Only the locales that actually have text — blanks are noise on the wire. */
const localized = (value: Localized | string | undefined) => {
   if (!value) return {}
   if (typeof value === 'string') return { fr: value }
   return Object.fromEntries(
      Object.entries(value).filter(([, v]) => typeof v === 'string' && v.trim())
   )
}

/**
 * A price in every currency on offer: the francs stored, and USD and EUR worked
 * out at the office's rates (fx.service). A currency with no rate is left out.
 */
const pickMoney = (value: Money | number | undefined) => inAllCurrencies(value)

/**
 * While a promotion runs (a listing, room or dish): the old price (shown struck
 * through) and the discount, rounded, from the francs. Display only:
 * `sellPrice` is charged. `endsAt` is its last day, at 00:00 UTC.
 */
const shown = (p: ReturnType<typeof livePromotion>) =>
   p
      ? {
           compareAtPrice: pickMoney(p.old),
           discountPercent: promotionPercent(p.old, p.sell),
           endsAt: p.endsAt?.toISOString(),
        }
      : undefined
const promotionOf = (x: Parameters<typeof livePromotion>[0]) => shown(livePromotion(x))

/** The promotion on one of a listing's prices: a car rate, a child or baby fare. */
const slotPromotion = (l: IListing, match: (s: PromoSlot) => boolean) => {
   const slot = promoSlotsOf(l.vertical).find(match)
   return slot && shown(livePromotionOf(l, slot))
}

/**
 * A hotel's or restaurant's card: its best running promotion, on which room or
 * dish, at what price. Absent when none runs.
 */
const promotedItem = (x?: IRoomType | IMenuItem) =>
   x ? { ...promotionOf(x), name: localized(x.name), price: pickMoney(x.sellPrice) } : undefined

/**
 * The rating and review count the public sees: approved customer reviews only
 * (`reviewStats`, see reviews.service). The stored `rating`/`reviewCount` came
 * from seeds and imports, not customers, so they are not published. Absent
 * until an item has its first approved review.
 */
type Reviewed = { reviewStats?: { rating?: number; count?: number } }
const ratingOf = (d: Reviewed) => (d.reviewStats?.count ? d.reviewStats.rating : undefined)
const reviewCountOf = (d: Reviewed) => d.reviewStats?.count || undefined

/**
 * Public catalogue DTOs. §14.3 rule 2: nothing here is shared with src/dto/admin
 * — separate file, separate field list, no common base object.
 *
 * Absent on purpose and permanently: `costPrice`, `supplier`, `createdBy`,
 * internal notes, raw quantity columns, and the Mongo `_id` of anything the
 * public reaches by slug. §14.3 rule 3 lists cost price and supplier as things
 * that must never appear on the public API under any circumstance — the way to
 * guarantee that is for the serialiser to have no field for them at all.
 */

const listingFields: FieldMap<IListing> = {
   id: (l) => l._id.toString(),
   vertical: (l) => l.vertical,
   /** Localised: the client picks a locale, the API does not decide for it. */
   title: (l) => localized(l.title),
   slug: (l) => l.slug,
   description: (l) => localized(l.description),
   status: (l) => l.status,
   city: (l) => l.city,
   country: (l) => l.country,
   geo: (l) => geoPoint(l.geo),
   images: (l) => l.images ?? [],
   // The address of the uploaded video, in our own storage (see `videoField`).
   videoUrl: (l) => l.videoUrl,
   /**
    * Per currency: whole francs as stored, and USD and EUR in cents, worked
    * out from them. Sell only: cost never leaves the admin surface. For a bus
    * or flight, the adult fare.
    */
   sellPrice: (l) => pickMoney(l.sellPrice),
   /** Bus and flight fares for a child of 2 to 12 and a baby under 2. */
   childPrice: (l) => (isScheduledRoute(l.vertical) ? pickMoney(l.childSellPrice) : undefined),
   infantPrice: (l) => (isScheduledRoute(l.vertical) ? pickMoney(l.infantSellPrice) : undefined),
   /**
    * A car's prices for 1, 6, 12 and 24 hours, the ones it is offered at,
    * shortest first, each with its own promotion. The 24-hour one is
    * `sellPrice`, its promotion `promotion`. Sell only, like the rest.
    */
   rentalRates: (l) =>
      l.vertical === VERTICALS.CAR
         ? carRates(l).map((r) => ({
              hours: r.hours,
              price: pickMoney(r.sell),
              promotion: slotPromotion(l, (s) => s.hours === r.hours),
           }))
         : undefined,
   /** The main price's: a car's 24 hours, a route's adult fare. */
   promotion: (l) => promotionOf(l),
   childPromotion: (l) => slotPromotion(l, (s) => s.fare === 'CHILD'),
   infantPromotion: (l) => slotPromotion(l, (s) => s.fare === 'INFANT'),
   /**
    * The biggest running discount on any other price (a car rate, a child or
    * baby fare), and which: a hint for a card that shows the main price only.
    */
   otherPromotion: (l) => {
      let best: { discountPercent: number; endsAt?: string; fare?: PromoSlot['fare']; hours?: number } | undefined
      for (const s of promoSlotsOf(l.vertical)) {
         const p = s.promo === MAIN_PROMO.promo ? undefined : shown(livePromotionOf(l, s))
         if (p && p.discountPercent > (best?.discountPercent ?? 0)) {
            best = { discountPercent: p.discountPercent, endsAt: p.endsAt, fare: s.fare, hours: s.hours }
         }
      }
      return best
   },
   /**
    * §4.5 availability, computed. The raw sold/held columns stay internal.
    * Absent for a bus or flight route: its seats are not counted.
    */
   available: (l) =>
      isScheduledRoute(l.vertical)
         ? undefined
         : Math.max((l.quantityTotal ?? 0) - (l.quantitySold ?? 0) - (l.quantityHeld ?? 0), 0),
   validFrom: (l) => l.validFrom?.toISOString(),
   validUntil: (l) => l.validUntil?.toISOString(),
   rating: ratingOf,
   reviewCount: reviewCountOf,
   attributes: (l) => {
      const a = (l.attributes as any)?.toObject
         ? (l.attributes as any).toObject()
         : { ...(l.attributes as any) }
      if (!a) return {}
      delete a._id
      // Dates must leave as ISO 8601 strings (§8): the client formats with
      // Intl, and a Date instance would serialise inconsistently.
      if (Array.isArray(a.segments)) {
         a.segments = a.segments.map((s: any) => ({
            carrier: s.carrier,
            flightNumber: s.flightNumber,
            origin: s.origin,
            destination: s.destination,
            departsAt: s.departsAt?.toISOString?.() ?? s.departsAt,
            arrivesAt: s.arrivesAt?.toISOString?.() ?? s.arrivesAt,
         }))
      }
      if (a.departsAt) a.departsAt = a.departsAt?.toISOString?.() ?? a.departsAt
      if (a.arrivesAt) a.arrivesAt = a.arrivesAt?.toISOString?.() ?? a.arrivesAt
      delete a.blackoutDates
      delete a.bookingDeadline
      delete a.recurrence
      return a
   },
}

export const presentListing = (l: IListing) => present(l, listingFields)
export const presentListings = (l: IListing[]) => presentList(l, listingFields)

/* ------------------------------------------------------------------- hotels */

const roomTypeFields: FieldMap<IRoomType> = {
   id: (r) => r._id.toString(),
   hotelId: (r) => r.hotel.toString(),
   name: (r) => localized(r.name),
   description: (r) => localized(r.description),
   maxAdults: (r) => r.maxAdults,
   maxChildren: (r) => r.maxChildren,
   beds: (r) => r.beds,
   amenities: (r) => r.amenities ?? [],
   images: (r) => r.images ?? [],
   mealPlan: (r) => r.mealPlan ?? 'ROOM_ONLY',
   /** Per night, for every night: one price holds until the office changes it. Rooms are not counted. */
   sellPrice: (r) => pickMoney(r.sellPrice),
   promotion: (r) => promotionOf(r),
   sizeSqm: (r) => (r as any).sizeSqm,
}

export interface HotelWithRooms extends IHotel {
   fromPrice?: Money
   roomTypes?: IRoomType[]
   /** The room with the best running promotion, if any. */
   promoItem?: IRoomType
}

const hotelFields: FieldMap<HotelWithRooms> = {
   id: (h) => h._id.toString(),
   name: (h) => localized(h.name),
   slug: (h) => h.slug,
   description: (h) => localized(h.description),
   stars: (h) => h.stars,
   address: (h) => h.address,
   city: (h) => h.city,
   country: (h) => h.country,
   geo: (h) => geoPoint(h.geo),
   amenities: (h) => h.amenities ?? [],
   images: (h) => h.images ?? [],
   videoUrl: (h) => h.videoUrl,
   checkInTime: (h) => h.checkInTime,
   checkOutTime: (h) => h.checkOutTime,
   policies: (h) => h.policies,
   rating: ratingOf,
   reviewCount: reviewCountOf,
   fromPrice: (h) => pickMoney(h.fromPrice),
   promotion: (h) => promotedItem(h.promoItem),
   roomTypes: (h) => presentList(h.roomTypes ?? [], roomTypeFields),
}

export const presentHotel = (h: HotelWithRooms) => present(h, hotelFields)
export const presentHotels = (h: HotelWithRooms[]) => presentList(h, hotelFields)

// ---------------------------------------------------------------------------

/**
 * Restaurants and their menus.
 *
 * `costPrice` has no entry here and never will — same rule as every other
 * sellable thing (§14.3 rule 3). Because these maps are allow-lists, leaving it
 * out is the whole protection: a field the serialiser cannot name is a field it
 * cannot publish, however the document is later extended.
 */

export interface MenuItemPublic extends IMenuItem {}

const menuItemFields: FieldMap<IMenuItem> = {
   id: (m) => m._id.toString(),
   restaurantId: (m) => m.restaurant.toString(),
   section: (m) => m.section,
   name: (m) => localized(m.name),
   description: (m) => localized(m.description),
   sellPrice: (m) => pickMoney(m.sellPrice),
   promotion: (m) => promotionOf(m),
   images: (m) => m.images ?? [],
   /** Drives the greyed-out "sold out today" row rather than hiding the dish. */
   isAvailable: (m) => m.isAvailable !== false,
   sortOrder: (m) => m.sortOrder ?? 0,
}

/**
 * Zones are public: the customer has to see the fee before they commit, and
 * §1 is explicit that a cost appearing only at the last step is the thing that
 * loses the order. The fee is still re-read server-side at checkout.
 */
const deliveryZoneFields: FieldMap<any> = {
   id: (z) => z._id.toString(),
   name: (z) => z.name,
   fee: (z) => pickMoney(z.fee),
   minOrder: (z) => (baseAmount(z.minOrder) > 0 ? pickMoney(z.minOrder) : undefined),
   etaMinutes: (z) => z.etaMinutes,
}

export interface RestaurantWithMenu extends IRestaurant {
   fromPrice?: Money
   menu?: IMenuItem[]
   /** The available dish with the best running promotion, if any. */
   promoItem?: IMenuItem
}

const restaurantFields: FieldMap<RestaurantWithMenu> = {
   id: (r) => r._id.toString(),
   name: (r) => localized(r.name),
   slug: (r) => r.slug,
   description: (r) => localized(r.description),
   cuisines: (r) => r.cuisines ?? [],
   address: (r) => r.address,
   city: (r) => r.city,
   country: (r) => r.country,
   geo: (r) => geoPoint(r.geo),
   images: (r) => r.images ?? [],
   videoUrl: (r) => r.videoUrl,
   openingHours: (r) => r.openingHours,
   prepTimeMinutes: (r) => r.prepTimeMinutes,
   phone: (r) => r.phone,
   rating: ratingOf,
   reviewCount: reviewCountOf,
   // Inactive zones are not offered, so they are not published either.
   deliveryZones: (r) =>
      presentList((r.deliveryZones ?? []).filter((z: any) => z.isActive), deliveryZoneFields),
   fromPrice: (r) => pickMoney(r.fromPrice),
   promotion: (r) => promotedItem(r.promoItem),
   menu: (r) => presentList(r.menu ?? [], menuItemFields),
}

export const presentRestaurant = (r: RestaurantWithMenu) => present(r, restaurantFields)
export const presentRestaurants = (r: RestaurantWithMenu[]) =>
   presentList(r, restaurantFields)
