import { Request, Response } from 'express'
import { isValidObjectId } from 'mongoose'
import { LISTING_STATUS, LOCALES } from '../../constants/domain.constants'
import {
   presentParking,
   presentParkings,
   presentVehicleCards,
   presentVehicleDetail,
} from '../../dto/public/catalogue.dto'
import { toLocalized } from '../../model/shared.schema'
import {
   Parking,
   SaleVehicle,
   VEHICLE_AVAILABILITY,
   VEHICLE_CONDITIONS,
   VehicleAccessory,
   VehicleSpec,
   VehicleType,
} from '../../model/vehicleSaleModel'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'
import { pageInfo, pageOf } from './catalogueController'

/**
 * Vehicles for sale, public: the deep search, its facets, the vehicle page and
 * the parkings. Only PUBLISHED vehicles of PUBLISHED parkings; the search and
 * the facets only AVAILABLE ones, while a reserved or sold vehicle's page still
 * opens (it says so and cannot be ordered). Every parameter is named and
 * parsed here — no filter language reaches the database.
 */

const PUBLISHED = LISTING_STATUS.PUBLISHED
const ON_SALE = { status: PUBLISHED, availability: VEHICLE_AVAILABILITY.AVAILABLE }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.replace(/\0/g, '').trim().slice(0, 80) : undefined)
/** A comma list, each entry trimmed, at most 30. */
const list = (v: unknown) =>
   (str(v) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 30)
const num = (v: unknown) => {
   const s = str(v)
   const n = s === undefined ? NaN : Number(s)
   return Number.isFinite(n) ? n : undefined
}
const escapeRx = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The whole word in any case, as typed ("toyota "): a pick, not a search. */
const exact = (v: string) => new RegExp(`^\\s*${escapeRx(v)}\\s*$`, 'i')
const range = (min?: number, max?: number) =>
   min === undefined && max === undefined
      ? undefined
      : { ...(min !== undefined ? { $gte: min } : {}), ...(max !== undefined ? { $lte: max } : {}) }

/**
 * `spec.<key>=a,b` (CHOICE) and `spec.<key>.min` / `.max` (NUMBER), read from
 * the raw URL: the app-wide sanitiser (express-mongo-sanitize) drops every
 * query key with a dot from `req.query`. Keys only ever name a spec looked up
 * below; values are matched as data.
 */
const specParams = (req: Request) => {
   const out = new Map<string, { choices?: string[]; min?: number; max?: number }>()
   const search = new URLSearchParams(req.originalUrl.split('?')[1] ?? '')
   for (const [name, value] of search) {
      const m = /^spec\.([a-z0-9-]{1,60})(?:\.(min|max))?$/.exec(name)
      if (!m || (out.size >= 30 && !out.has(m[1]))) continue
      const entry = out.get(m[1]) ?? {}
      if (m[2] === 'min' || m[2] === 'max') entry[m[2]] = num(value)
      else entry.choices = list(value)
      out.set(m[1], entry)
   }
   return out
}

/** Matches nothing: a filter naming only unknown things finds no vehicle. */
const NONE = { _id: { $in: [] } }

/** The search's filter, from every parameter the contract names. */
const searchFilter = async (req: Request) => {
   const q = req.query
   const filter: Record<string, any> = { ...ON_SALE }
   const and: Record<string, any>[] = []

   // Published parkings only — of a town, or the one asked for.
   const parkings: Record<string, any> = { status: PUBLISHED }
   if (str(q.city)) parkings.city = exact(str(q.city)!)
   if (str(q.parking)) {
      if (!isValidObjectId(str(q.parking))) return NONE
      parkings._id = str(q.parking)
   }
   filter.parking = { $in: await Parking.distinct('_id', parkings) }

   const types = list(q.type).map((t) => t.toLowerCase())
   if (types.length) filter.vehicleType = { $in: await VehicleType.distinct('_id', { slug: { $in: types } }) }
   const makes = list(q.make)
   if (makes.length) filter.make = { $in: makes.map(exact) }
   const models = list(q.model)
   if (models.length) filter.model = { $in: models.map(exact) }

   const year = range(num(q.yearMin), num(q.yearMax))
   if (year) filter.year = year
   // In francs, the base, as every price filter.
   const price = range(num(q.priceMin), num(q.priceMax))
   if (price) filter['sellPrice.CDF'] = price
   const mileage = range(undefined, num(q.mileageMax))
   if (mileage) filter.mileageKm = mileage
   const condition = str(q.condition)?.toUpperCase()
   if (condition && (VEHICLE_CONDITIONS as readonly string[]).includes(condition)) filter.condition = condition

   // Must have them ALL. An accessory no longer listed narrows nothing.
   const accessoryKeys = list(q.accessories).map((k) => k.toLowerCase())
   if (accessoryKeys.length) {
      const ids = await VehicleAccessory.distinct('_id', { key: { $in: accessoryKeys }, isActive: true })
      if (ids.length) filter.accessories = { $all: ids }
   }

   const asked = specParams(req)
   if (asked.size) {
      const defs = await VehicleSpec.find({ key: { $in: [...asked.keys()] }, isActive: true, filterable: true })
         .select('key valueType')
         .lean()
      for (const def of defs) {
         const want = asked.get(def.key)!
         if (def.valueType === 'CHOICE' && want.choices?.length) {
            and.push({ specs: { $elemMatch: { spec: def._id, choice: { $in: want.choices } } } })
         }
         const span = range(want.min, want.max)
         if (def.valueType === 'NUMBER' && span) and.push({ specs: { $elemMatch: { spec: def._id, number: span } } })
      }
   }

   // The search box: make, model, title in any language, stock reference.
   if (str(q.q)) {
      const rx = new RegExp(escapeRx(str(q.q)!), 'i')
      and.push({
         $or: [{ make: rx }, { model: rx }, { stockRef: rx }, ...LOCALES.map((l) => ({ [`title.${l}`]: rx }))],
      })
   }
   if (and.length) filter.$and = and
   return filter
}

/** `_id` settles ties, so a vehicle never shows on two pages, or on none. */
const SORTS: Record<string, Record<string, 1 | -1>> = {
   newest: { createdAt: -1, _id: -1 },
   priceAsc: { 'sellPrice.CDF': 1, _id: 1 },
   priceDesc: { 'sellPrice.CDF': -1, _id: 1 },
   yearDesc: { year: -1, _id: 1 },
   mileageAsc: { mileageKm: 1, _id: 1 },
}

/** What a card needs alongside the vehicle. */
const withCardRefs = (query: any) =>
   query.populate('parking', 'slug name city').populate('vehicleType', 'slug name').populate('specs.spec')

/**
 * GET /api/v1/vehicles — the deep search. 30 a page unless asked (the site's
 * page size), 60 at most.
 */
export const searchVehicles = catchAsync(async (req: Request, res: Response) => {
   const filter = await searchFilter(req)
   const paging = pageOf({ ...req.query, limit: str(req.query.limit) ?? '30' })
   const sortKey = str(req.query.sort) ?? 'newest'
   const sort = Object.hasOwn(SORTS, sortKey) ? SORTS[sortKey] : SORTS.newest
   const [docs, total] = await Promise.all([
      withCardRefs(SaleVehicle.find(filter).sort(sort).skip(paging.skip).limit(paging.limit)).lean(),
      SaleVehicle.countDocuments(filter),
   ])
   sendResponse(res, 200, 'Vehicles', { items: presentVehicleCards(docs), ...pageInfo(total, paging) })
})

/** Smallest and largest, or [0, 0] when there is none. */
const bounds = (values: (number | undefined)[]): [number, number] => {
   const nums = values.filter((n): n is number => typeof n === 'number')
   return nums.length ? [Math.min(...nums), Math.max(...nums)] : [0, 0]
}
const tally = (keys: unknown[]) => {
   const out = new Map<string, number>()
   for (const k of keys) if (k !== undefined && k !== null) out.set(String(k), (out.get(String(k)) ?? 0) + 1)
   return out
}
const groupOf = (value: unknown) => {
   const g = toLocalized(value)
   return Object.keys(g).length ? g : undefined
}

/**
 * GET /api/v1/vehicles/facets — everything the deep search offers, counted
 * over what is on sale now. A choice, a type or an accessory no vehicle on
 * sale has is not offered.
 * ponytail: counted in memory over at most 5 000 vehicles; aggregate in the database past that.
 */
export const vehicleFacets = catchAsync(async (_req: Request, res: Response) => {
   const [parkings, types, specs, accessories] = await Promise.all([
      Parking.find({ status: PUBLISHED }).select('slug name city').lean(),
      VehicleType.find({ isActive: true }).sort({ sortOrder: 1, slug: 1 }).lean(),
      // A text spec has no filter: the search takes choices and number ranges.
      VehicleSpec.find({ isActive: true, filterable: true, valueType: { $in: ['CHOICE', 'NUMBER'] } })
         .sort({ sortOrder: 1, key: 1 })
         .lean(),
      VehicleAccessory.find({ isActive: true }).sort({ sortOrder: 1, key: 1 }).lean(),
   ])
   const rows: any[] = await SaleVehicle.find({ ...ON_SALE, parking: { $in: parkings.map((p) => p._id) } })
      .select('parking vehicleType make model year mileageKm sellPrice condition specs accessories')
      .limit(5000)
      .lean()

   const byParking = tally(rows.map((r) => r.parking))
   const byCity = new Map<string, number>()
   for (const p of parkings) {
      const n = byParking.get(String(p._id)) ?? 0
      if (n) byCity.set(p.city, (byCity.get(p.city) ?? 0) + n)
   }
   const byType = tally(rows.map((r) => r.vehicleType))
   const byCondition = tally(rows.map((r) => r.condition))
   const byAccessory = tally(rows.flatMap((r) => r.accessories ?? []))

   // Each make once, however it was typed ("Toyota", "toyota "); its models likewise.
   const makes = new Map<string, { make: string; count: number; models: Map<string, { model: string; count: number }> }>()
   for (const r of rows) {
      const make = String(r.make ?? '').trim()
      if (!make) continue
      const m = makes.get(make.toLowerCase()) ?? { make, count: 0, models: new Map() }
      m.count += 1
      const model = String(r.model ?? '').trim()
      if (model) {
         const mm = m.models.get(model.toLowerCase()) ?? { model, count: 0 }
         mm.count += 1
         m.models.set(model.toLowerCase(), mm)
      }
      makes.set(make.toLowerCase(), m)
   }
   const byName = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b), 'fr')

   const values = (specId: unknown) =>
      rows.flatMap((r) => ((r.specs ?? []) as any[]).filter((s) => String(s.spec) === String(specId)))

   sendResponse(res, 200, 'Vehicle facets', {
      cities: [...byCity].map(([city, count]) => ({ city, count })).sort(byName((c) => c.city)),
      parkings: parkings
         .filter((p) => byParking.get(String(p._id)))
         .map((p) => ({ id: String(p._id), slug: p.slug, name: toLocalized(p.name), city: p.city, count: byParking.get(String(p._id))! }))
         .sort(byName((p) => `${p.city} ${p.name.fr ?? ''}`)),
      types: types
         .filter((t) => byType.get(String(t._id)))
         .map((t) => ({ slug: t.slug, name: toLocalized(t.name), count: byType.get(String(t._id))! })),
      makes: [...makes.values()]
         .map((m) => ({ make: m.make, count: m.count, models: [...m.models.values()].sort(byName((x) => x.model)) }))
         .sort(byName((m) => m.make)),
      year: bounds(rows.map((r) => r.year)),
      price: bounds(rows.map((r) => r.sellPrice?.CDF)),
      mileage: bounds(rows.map((r) => r.mileageKm)),
      conditions: VEHICLE_CONDITIONS.filter((c) => byCondition.get(c)).map((c) => ({ condition: c, count: byCondition.get(c)! })),
      specs: specs.flatMap((s): Record<string, unknown>[] => {
         const stored = values(s._id)
         const head = { key: s.key, name: toLocalized(s.name), valueType: s.valueType, unit: s.unit || undefined }
         if (s.valueType === 'CHOICE') {
            const counts = tally(stored.map((v) => v.choice))
            const choices = (s.choices ?? [])
               .filter((c) => counts.get(c.key))
               .map((c) => ({ key: c.key, label: toLocalized(c.label), count: counts.get(c.key)! }))
            return choices.length ? [{ ...head, choices }] : []
         }
         const nums = stored.map((v) => v.number).filter((n): n is number => typeof n === 'number')
         return nums.length ? [{ ...head, range: bounds(nums) }] : []
      }),
      accessories: accessories
         .filter((a) => byAccessory.get(String(a._id)))
         .map((a) => ({ key: a.key, name: toLocalized(a.name), group: groupOf(a.group), count: byAccessory.get(String(a._id))! })),
   })
})

/** GET /api/v1/vehicles/:stockRef — the vehicle page, reserved and sold ones included. */
export const getVehicle = catchAsync(async (req: Request, res: Response) => {
   const vehicle: any = await SaleVehicle.findOne({
      stockRef: String(req.params.stockRef).trim().toUpperCase().slice(0, 20),
      status: PUBLISHED,
   })
      .populate('parking')
      .populate('vehicleType', 'slug name')
      .populate('specs.spec')
      .lean()
   if (!vehicle || vehicle.parking?.status !== PUBLISHED) throw new AppError('Vehicle not found', 404)
   const accessories = await VehicleAccessory.find({ isActive: true }).sort({ sortOrder: 1, key: 1 }).lean()
   sendResponse(res, 200, 'Vehicle', { vehicle: presentVehicleDetail(vehicle, accessories) })
})

/** Vehicles on sale per parking. */
const onSaleCounts = async (ids: unknown[]) => {
   const rows = await SaleVehicle.aggregate([
      { $match: { ...ON_SALE, parking: { $in: ids } } },
      { $group: { _id: '$parking', n: { $sum: 1 } } },
   ])
   return new Map(rows.map((r: any) => [String(r._id), r.n as number]))
}

/** GET /api/v1/parkings?city= — the published parkings, a town's when asked. */
export const listParkings = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, any> = { status: PUBLISHED }
   if (str(req.query.city)) filter.city = exact(str(req.query.city)!)
   const parkings: any[] = await Parking.find(filter)
      .sort({ city: 1, 'name.fr': 1 })
      .limit(200)
      .populate('vehicleTypes', 'slug name isActive sortOrder')
      .lean()
   const counts = await onSaleCounts(parkings.map((p) => p._id))
   sendResponse(res, 200, 'Parkings', {
      items: presentParkings(parkings.map((p) => ({ ...p, vehicleCount: counts.get(String(p._id)) ?? 0 }))),
   })
})

/** GET /api/v1/parkings/:slug */
export const getParking = catchAsync(async (req: Request, res: Response) => {
   const parking: any = await Parking.findOne({ slug: String(req.params.slug).toLowerCase(), status: PUBLISHED })
      .populate('vehicleTypes', 'slug name isActive sortOrder')
      .lean()
   if (!parking) throw new AppError('Parking not found', 404)
   const counts = await onSaleCounts([parking._id])
   sendResponse(res, 200, 'Parking', {
      parking: presentParking({ ...parking, vehicleCount: counts.get(String(parking._id)) ?? 0 }),
   })
})
