import { VERTICALS } from '../../constants/domain.constants'
import { IHotel, IRoomType } from '../../model/hotelModel'
import {
   IListing,
   isScheduledRoute,
   LISTING_TEXT_ATTRIBUTES,
   listingTags,
   livePromotion,
   livePromotionOf,
   MAIN_PROMO,
   PromoSlot,
   promoSlotsOf,
   promotionPercent,
} from '../../model/listingModel'
import { IMenuItem, IRestaurant } from '../../model/restaurantModel'
import { baseAmount, geoPoint, Money, publicFee, tagTranslationsOf, toLocalized } from '../../model/shared.schema'
import { inAllCurrencies } from '../../services/fx.service'
import { carRates } from '../../services/orders/rental.service'
import { vehicleName } from '../../services/vehicleSale.service'
import { textOut } from '../../utils/clientContent'
import { FieldMap, present, presentList } from '../../utils/present'

/** Only the locales that actually have text — blanks are noise on the wire. A plain string is French. */
const localized = toLocalized

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
   /** Once per booking, whatever the quantity; absent when none (a property has no checkout). */
   processingFee: (l) => (l.vertical === VERTICALS.PROPERTY ? undefined : publicFee(l.processingFee)),
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
      // The texts customers read: only the languages with text, gone when there is none.
      for (const k of LISTING_TEXT_ATTRIBUTES) {
         const text = textOut(a[k], localized)
         if (typeof text === 'string' ? text : Object.keys(text).length) a[k] = text
         else delete a[k]
      }
      return a
   },
   /** `{ [word]: Localized }`: how to show each word of the lists, where the office translated it. */
   tagTranslations: (l) => tagTranslationsOf(l.tagTranslations, listingTags(l), false),
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
   beds: (r) => textOut(r.beds, localized),
   amenities: (r) => r.amenities ?? [],
   tagTranslations: (r) => tagTranslationsOf(r.tagTranslations, r.amenities ?? [], false),
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
   tagTranslations: (h) => tagTranslationsOf(h.tagTranslations, h.amenities ?? [], false),
   images: (h) => h.images ?? [],
   videoUrl: (h) => h.videoUrl,
   checkInTime: (h) => h.checkInTime,
   checkOutTime: (h) => h.checkOutTime,
   policies: (h) => textOut(h.policies, localized),
   rating: ratingOf,
   reviewCount: reviewCountOf,
   fromPrice: (h) => pickMoney(h.fromPrice),
   /** The hotel's, once per stay whatever the rooms and nights; absent when none. */
   processingFee: (h) => publicFee(h.processingFee),
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
   name: (z) => textOut(z.name, localized),
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
   tagTranslations: (r) => tagTranslationsOf(r.tagTranslations, r.cuisines ?? [], false),
   address: (r) => r.address,
   city: (r) => r.city,
   country: (r) => r.country,
   geo: (r) => geoPoint(r.geo),
   images: (r) => r.images ?? [],
   videoUrl: (r) => r.videoUrl,
   openingHours: (r) => textOut(r.openingHours, localized),
   prepTimeMinutes: (r) => r.prepTimeMinutes,
   phone: (r) => r.phone,
   rating: ratingOf,
   reviewCount: reviewCountOf,
   // Inactive zones are not offered, so they are not published either.
   deliveryZones: (r) =>
      presentList((r.deliveryZones ?? []).filter((z: any) => z.isActive), deliveryZoneFields),
   fromPrice: (r) => pickMoney(r.fromPrice),
   /** Once per delivery order, not per dish; absent when none. */
   processingFee: (r) => publicFee(r.processingFee),
   promotion: (r) => promotedItem(r.promoItem),
   menu: (r) => presentList(r.menu ?? [], menuItemFields),
}

export const presentRestaurant = (r: RestaurantWithMenu) => present(r, restaurantFields)
export const presentRestaurants = (r: RestaurantWithMenu[]) =>
   presentList(r, restaurantFields)

/* -------------------------------------------------------- vehicles for sale */

/**
 * Vehicles for sale, read with their parking, type and specs populated.
 *
 * `costPrice`, `vin`, `reservedOrder`, `soldAt` and the parking's supplier have
 * no entry here and never will (§14.3 rule 3): the office's, not the public's.
 */

type SpecDef = {
   key: string
   name: unknown
   valueType: string
   unit?: string
   choices?: { key: string; label: unknown }[]
   onCard?: boolean
   isActive?: boolean
   sortOrder?: number
}

/** A stored value as shown: a choice's label, a number as text, a text per language. */
const specValue = (def: SpecDef, s: { choice?: string; number?: number; text?: unknown }) => {
   if (def.valueType === 'CHOICE') {
      const choice = def.choices?.find((c) => c.key === s.choice)
      return choice ? localized(choice.label) : undefined
   }
   if (def.valueType === 'NUMBER') return typeof s.number === 'number' ? String(s.number) : undefined
   const text = localized(s.text)
   return Object.keys(text).length ? text : undefined
}

/** The vehicle's specs the office has active, in the office's order; only the card ones for a card. */
const specRows = (v: any, cardOnly: boolean) =>
   ((v.specs ?? []) as any[])
      .filter((s) => s?.spec?.key && s.spec.isActive !== false && (!cardOnly || s.spec.onCard))
      .sort((a, b) => (a.spec.sortOrder ?? 0) - (b.spec.sortOrder ?? 0))
      .map((s) => ({ def: s.spec as SpecDef, value: specValue(s.spec, s) }))
      .filter((r) => r.value !== undefined)

const vehicleCardFields: FieldMap<any> = {
   id: (v) => v._id.toString(),
   stockRef: (v) => v.stockRef,
   /** The office's title per language, else "Make Model Year" as one string. */
   title: (v) => {
      const title = localized(v.title)
      return Object.keys(title).length ? title : vehicleName(v)
   },
   make: (v) => v.make,
   model: (v) => v.model,
   year: (v) => v.year,
   mileageKm: (v) => v.mileageKm,
   condition: (v) => v.condition,
   colour: (v) => v.colour || undefined,
   vehicleType: (v) => (v.vehicleType?.slug ? { slug: v.vehicleType.slug, name: localized(v.vehicleType.name) } : undefined),
   // A vehicle's town is its parking's.
   city: (v) => v.parking?.city,
   parking: (v) => (v.parking?._id ? { id: v.parking._id.toString(), slug: v.parking.slug, name: localized(v.parking.name) } : undefined),
   sellPrice: (v) => pickMoney(v.sellPrice),
   /** Once per order; absent when none. */
   processingFee: (v) => publicFee(v.processingFee),
   promotion: (v) => promotionOf(v),
   image: (v) => v.images?.[0],
   imageCount: (v) => v.images?.length ?? 0,
   cardSpecs: (v) =>
      specRows(v, true).map(({ def, value }) => ({ key: def.key, name: localized(def.name), value, unit: def.unit || undefined })),
   createdAt: (v) => v.createdAt?.toISOString?.() ?? v.createdAt,
}

export const presentVehicleCards = (v: any[]) => presentList(v, vehicleCardFields)

/** A parking as the vehicle page shows it, where the vehicle is collected. */
const parkingBlock = (p: any) =>
   p?._id
      ? {
           id: p._id.toString(),
           slug: p.slug,
           name: localized(p.name),
           city: p.city,
           address: p.address,
           geo: geoPoint(p.geo),
           phone: p.phone || undefined,
           openingHours: textOut(p.openingHours, localized),
           images: p.images ?? [],
        }
      : undefined

/**
 * The vehicle page. `accessories`: every active accessory, in the office's
 * order — the page ticks what this vehicle has and greys the rest.
 */
export const presentVehicleDetail = (v: any, accessories: any[]) =>
   present(v, {
      ...vehicleCardFields,
      description: (x) => localized(x.description),
      images: (x) => x.images ?? [],
      videoUrl: (x) => x.videoUrl,
      specs: (x) =>
         specRows(x, false).map(({ def, value }) => ({
            key: def.key,
            name: localized(def.name),
            valueType: def.valueType,
            unit: def.unit || undefined,
            value,
         })),
      accessories: (x) => {
         const has = new Set(((x.accessories ?? []) as unknown[]).map(String))
         return accessories.map((a) => {
            const group = localized(a.group)
            return {
               key: a.key,
               name: localized(a.name),
               group: Object.keys(group).length ? group : undefined,
               has: has.has(String(a._id)),
            }
         })
      },
      parking: (x) => parkingBlock(x.parking),
      // RESERVED or SOLD still opens: the page says so and offers no order.
      availability: (x) => x.availability,
   })

const parkingFields: FieldMap<any> = {
   id: (p) => p._id.toString(),
   slug: (p) => p.slug,
   name: (p) => localized(p.name),
   description: (p) => localized(p.description),
   city: (p) => p.city,
   address: (p) => p.address,
   geo: (p) => geoPoint(p.geo),
   phone: (p) => p.phone || undefined,
   openingHours: (p) => textOut(p.openingHours, localized),
   images: (p) => p.images ?? [],
   // The types it holds, active ones, in the office's order.
   vehicleTypes: (p) =>
      ((p.vehicleTypes ?? []) as any[])
         .filter((t) => t?.slug && t.isActive !== false)
         .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
         .map((t) => ({ slug: t.slug, name: localized(t.name) })),
   /** Vehicles on sale there now. */
   vehicleCount: (p) => p.vehicleCount ?? 0,
}

export const presentParking = (p: any) => present(p, parkingFields)
export const presentParkings = (p: any[]) => presentList(p, parkingFields)
