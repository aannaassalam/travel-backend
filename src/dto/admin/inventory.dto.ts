import { IHotel, IRatePlan, IRoomType } from '../../model/hotelModel'
import {
   availableCurrencies,
   baseAmount,
   resolveLocalized,
   translationStatus,
} from '../../model/shared.schema'
import { FieldMap, present, presentList } from '../../utils/present'

/**
 * Admin inventory DTOs. These carry costPrice, supplier and margin — the exact
 * fields §2.1 warns must never reach the public surface. That is why there is
 * no shared serializer: one missing conditional would publish purchase prices.
 */

const hotelFields: FieldMap<IHotel> = {
   id: (h) => h._id.toString(),
   // Full map for the editor, plus a resolved string for lists and headings.
   name: (h) => h.name,
   displayName: (h) => resolveLocalized(h.name),
   slug: (h) => h.slug,
   description: (h) => h.description,
   status: (h) => h.status,
   stars: (h) => h.stars,
   address: (h) => h.address,
   city: (h) => h.city,
   country: (h) => h.country,
   geo: (h) => h.geo,
   amenities: (h) => h.amenities,
   images: (h) => h.images,
   supplier: (h) => h.supplier,
   checkInTime: (h) => h.checkInTime,
   checkOutTime: (h) => h.checkOutTime,
   policies: (h) => h.policies,
   /**
    * §5.1 translation indicator. A locale counts as done only when BOTH the
    * name and the description exist — a translated description under an
    * untranslated name still reads as broken to the visitor.
    */
   translations: (h) => {
      const n = translationStatus(h.name)
      const d = translationStatus(h.description)
      return Object.fromEntries(
         Object.keys(n).map((l) => [l, n[l] && d[l]])
      ) as Record<string, boolean>
   },
   version: (h) => (h as any).__v,
   createdAt: (h) => h.createdAt,
   updatedAt: (h) => h.updatedAt,
}

export const presentHotel = (h: IHotel) => present(h, hotelFields)
export const presentHotels = (h: IHotel[]) => presentList(h, hotelFields)

const roomTypeFields: FieldMap<IRoomType> = {
   id: (r) => r._id.toString(),
   hotelId: (r) => r.hotel?.toString(),
   name: (r) => r.name,
   displayName: (r) => resolveLocalized(r.name),
   description: (r) => r.description,
   maxAdults: (r) => r.maxAdults,
   maxChildren: (r) => r.maxChildren,
   beds: (r) => r.beds,
   amenities: (r) => r.amenities,
   images: (r) => r.images,
   status: (r) => r.status,
   version: (r) => (r as any).__v,
}

export const presentRoomType = (r: IRoomType) => present(r, roomTypeFields)
export const presentRoomTypes = (r: IRoomType[]) =>
   presentList(r, roomTypeFields)

/** One cell of the §5.2 calendar grid. */
const ratePlanFields: FieldMap<IRatePlan> = {
   id: (p) => p._id.toString(),
   roomTypeId: (p) => p.roomType?.toString(),
   date: (p) => p.date.toISOString().slice(0, 10),
   // Full per-currency maps; the grid shows base and the editor shows all.
   costPrice: (p) => p.costPrice,
   sellPrice: (p) => p.sellPrice,
   costPriceBase: (p) => baseAmount(p.costPrice),
   sellPriceBase: (p) => baseAmount(p.sellPrice),
   currencies: (p) => availableCurrencies(p.sellPrice),
   allotment: (p) => p.allotment,
   sold: (p) => p.sold,
   held: (p) => p.held,
   available: (p) => Math.max(p.allotment - p.sold - p.held, 0),
   mealPlan: (p) => p.mealPlan,
   blocked: (p) => p.blocked,
   margin: (p) => baseAmount(p.sellPrice) - baseAmount(p.costPrice),
}

export const presentRatePlans = (p: IRatePlan[]) =>
   presentList(p, ratePlanFields)
