import { NextFunction, Request, Response } from 'express'
import { isValidObjectId, Model } from 'mongoose'
import slugify from 'slugify'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { LISTING_STATUS, LOCALES } from '../../constants/domain.constants'
import {
   baseAmount,
   everyLocale,
   geoPoint,
   Localized,
   parseGeo,
   parseFee,
   parseLocalized,
   parseMoney,
   resolveLocalized,
} from '../../model/shared.schema'
import {
   IParking,
   ISaleVehicle,
   IVehicleAccessory,
   IVehicleSpec,
   IVehicleType,
   nextStockRef,
   Parking,
   SaleVehicle,
   SPEC_VALUE_TYPES,
   VEHICLE_CONDITIONS,
   VehicleAccessory,
   VehicleSpec,
   VehicleType,
} from '../../model/vehicleSaleModel'
import {
   archiveDoc,
   createDoc,
   deactivateDoc,
   deleteDoc,
   paginate,
   sortBy,
   updateDoc,
} from '../../services/adminCrud.service'
import { recordAudit } from '../../services/auditLog.service'
import { applyPromotion, touchesPromotion } from '../../services/promotion.service'
import { addStarterCatalogue, vehicleLabel } from '../../services/vehicleSale.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { pick } from '../../utils/pick'
import { FieldMap, present, presentList } from '../../utils/present'
import { sendResponse } from '../../utils/response'
import { uniqueSlug } from '../../utils/uniqueSlug'
import { supplierRef } from './supplierController'

/**
 * Vehicles for sale, admin side: the office's lists (types, specifications,
 * accessories), the parkings, and the vehicles. Inventory permissions and the
 * shared write path (adminCrud: audit log, version/409), as restaurants. The
 * fields the public never sees — `vin`, `costPrice`, the reserving order —
 * are here only. `availability` is never taken from a body: orders move it.
 */

const ENTITY = {
   TYPE: 'VehicleType',
   SPEC: 'VehicleSpec',
   ACCESSORY: 'VehicleAccessory',
   PARKING: 'Parking',
   VEHICLE: 'SaleVehicle',
}

// ------------------------------------------------------------- input checks

const text = (raw: unknown, label: string, max: number, required = false) => {
   if (raw === undefined || raw === null) {
      if (required) throw new AppError(`${label} is required`, 400)
      return ''
   }
   if (typeof raw !== 'string' && typeof raw !== 'number') throw new AppError(`${label} must be text`, 400)
   const v = String(raw).replace(/\0/g, '').trim()
   if (required && !v) throw new AppError(`${label} is required`, 400)
   if (v.length > max) throw new AppError(`${label} is limited to ${max} characters`, 400)
   return v
}

/** Per language; French required where the record needs a name. */
const localizedIn = (raw: unknown, label: string, max: number, frRequired = false): Localized => {
   const out = parseLocalized(raw, label, max)
   if (frRequired && !out.fr) throw new AppError(`${label}: the French text is required`, 400)
   return out
}

/** A whole number in range; blank or null clears an optional one. */
const whole = (raw: unknown, label: string, min: number, max: number) => {
   if (raw === null || raw === '') return null
   const n = Number(raw)
   if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`${label} must be a whole number from ${min} to ${max}`, 400)
   return n
}

const sortOrder = (raw: unknown) => {
   const n = raw === '' || raw === null ? NaN : Number(raw)
   if (!Number.isFinite(n)) throw new AppError('The order must be a number', 400)
   return n
}

const images = (raw: unknown, label = 'Photos') => {
   if (!Array.isArray(raw) || raw.length > 30 || raw.some((i) => typeof i !== 'string' || i.length > 1000)) {
      throw new AppError(`${label}: a list of uploaded pictures (30 at most)`, 400)
   }
   return raw.map((i) => i.trim()).filter(Boolean)
}

/** A stable key from what was typed, or from the French name. */
const keyOf = (raw: unknown, fallback: string) =>
   slugify(String(typeof raw === 'string' && raw.trim() ? raw : fallback), { lower: true, strict: true }).slice(0, 60)

/** `key`, or `key-2`, `key-3`…: the first one no record of this list has. */
const uniqueKey = async (model: Model<any>, base: string) => {
   for (let n = 1; n < 200; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`
      if (!(await model.exists({ key: candidate }))) return candidate
   }
   return `${base}-${Date.now()}`
}

const searchRx = (v: unknown) => {
   const term = typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, 80) : ''
   return term ? new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : undefined
}

const notFound = (what: string) => new AppError(`${what} not found`, 404)

/** How many vehicles name each id at `path` (an array path is unwound first). */
const usage = async (path: string, unwind?: string) => {
   const rows = await SaleVehicle.aggregate([
      ...(unwind ? [{ $unwind: `$${unwind}` }] : []),
      { $group: { _id: `$${path}`, n: { $sum: 1 } } },
   ])
   return new Map(rows.map((r: any) => [String(r._id), r.n as number]))
}

/** 409 with the count while vehicles use it; the office moves or edits them first. */
const refuseInUse = (count: number, what: string) => {
   if (count) {
      throw new AppError(
         `${count} vehicle${count === 1 ? ' uses' : 's use'} this ${what}. Change ${count === 1 ? 'it' : 'them'} first.`,
         409,
         'IN_USE'
      )
   }
}

// ================================================================ the lists

const typeFields: FieldMap<IVehicleType> = {
   id: (t) => t._id.toString(),
   name: (t) => everyLocale(t.name),
   displayName: (t) => resolveLocalized(t.name),
   slug: (t) => t.slug,
   sortOrder: (t) => t.sortOrder,
   isActive: (t) => t.isActive,
   version: (t) => (t as any).__v,
}

const specFields: FieldMap<IVehicleSpec> = {
   id: (s) => s._id.toString(),
   name: (s) => everyLocale(s.name),
   displayName: (s) => resolveLocalized(s.name),
   key: (s) => s.key,
   valueType: (s) => s.valueType,
   unit: (s) => s.unit ?? '',
   choices: (s) => (s.choices ?? []).map((c) => ({ key: c.key, label: everyLocale(c.label) })),
   filterable: (s) => s.filterable,
   onCard: (s) => s.onCard,
   sortOrder: (s) => s.sortOrder,
   isActive: (s) => s.isActive,
   version: (s) => (s as any).__v,
}

const accessoryFields: FieldMap<IVehicleAccessory> = {
   id: (a) => a._id.toString(),
   name: (a) => everyLocale(a.name),
   displayName: (a) => resolveLocalized(a.name),
   key: (a) => a.key,
   group: (a) => everyLocale(a.group),
   sortOrder: (a) => a.sortOrder,
   isActive: (a) => a.isActive,
   version: (a) => (a as any).__v,
}

/** The fields every list entry shares. Only what the body carries is checked. */
const checkListEntry = (body: Record<string, any>) => {
   if (body.name !== undefined) body.name = localizedIn(body.name, 'Name', 120, true)
   if (body.sortOrder !== undefined) body.sortOrder = sortOrder(body.sortOrder)
   if (body.isActive !== undefined) body.isActive = Boolean(body.isActive)
}

/** A list, in the office's order, each entry with how many vehicles use it. */
const listOf = <T>(model: Model<T>, fields: FieldMap<any>, counts: () => Promise<Map<string, number>>) =>
   catchAsync(async (_req: Request, res: Response) => {
      const [items, used] = await Promise.all([model.find().sort({ sortOrder: 1, 'name.fr': 1 }).limit(500), counts()])
      return sendResponse(res, 200, 'OK', {
         items: items.map((d: any) => ({ ...present(d, fields), vehicleCount: used.get(String(d._id)) ?? 0 })),
      })
   })

// --- types

export const listTypes = listOf(VehicleType, typeFields, () => usage('vehicleType'))

export const createType = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, ['name', 'sortOrder', 'isActive'])
   body.name ??= ''
   checkListEntry(body)
   body.slug = await uniqueSlug(VehicleType, [keyOf(req.body.slug, body.name.fr)])
   const type = await createDoc<IVehicleType>(req, VehicleType, body, { entityType: ENTITY.TYPE })
   return sendResponse(res, 201, 'Type added', { type: present(type, typeFields) })
})

/** The slug is fixed once made: the website's links filter by it. */
export const updateType = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, ['name', 'sortOrder', 'isActive'])
   checkListEntry(body)
   const type = await updateDoc<IVehicleType>(req, VehicleType, req.params.id, body, { entityType: ENTITY.TYPE })
   return sendResponse(res, 200, 'Type saved', { type: present(type, typeFields) })
})

export const deleteType = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!isValidObjectId(req.params.id)) return next(notFound(ENTITY.TYPE))
   refuseInUse(await SaleVehicle.countDocuments({ vehicleType: req.params.id }), 'type')
   await deleteDoc(req, VehicleType, { _id: req.params.id }, {
      entityType: ENTITY.TYPE,
      // No parking goes on listing a type that is gone.
      withIt: () => Parking.updateMany({ vehicleTypes: req.params.id }, { $pull: { vehicleTypes: req.params.id } }),
   })
   return sendResponse(res, 200, 'Type deleted', {})
})

// --- specifications

const SPEC_FIELDS = ['name', 'unit', 'choices', 'filterable', 'onCard', 'sortOrder', 'isActive'] as const

/** Choices: a French label each, a key kept as sent (stored values name it) or made from the label. */
const parseChoices = (raw: unknown) => {
   if (!Array.isArray(raw) || raw.length > 60) throw new AppError('Choices: a list of 60 at most', 400)
   const seen = new Set<string>()
   return raw.map((c: any, i) => {
      const label = localizedIn(c?.label, `Choice ${i + 1}`, 80, true)
      let key = keyOf(c?.key, label.fr!)
      if (!key) throw new AppError(`Choice ${i + 1}: the French label needs a letter or a digit`, 400)
      for (let n = 2; seen.has(key); n++) key = `${keyOf(c?.key, label.fr!)}-${n}`
      seen.add(key)
      return { key, label }
   })
}

const checkSpec = (body: Record<string, any>, valueType: string) => {
   checkListEntry(body)
   for (const flag of ['filterable', 'onCard'] as const) if (body[flag] !== undefined) body[flag] = Boolean(body[flag])
   // A unit is a number's, choices a choice's: neither is kept on another kind.
   if (body.unit !== undefined || valueType !== 'NUMBER') body.unit = valueType === 'NUMBER' ? text(body.unit, 'Unit', 20) : ''
   if (body.choices !== undefined || valueType !== 'CHOICE') body.choices = valueType === 'CHOICE' ? parseChoices(body.choices ?? []) : []
}

export const listSpecs = listOf(VehicleSpec, specFields, () => usage('specs.spec', 'specs'))

export const createSpec = catchAsync(async (req: Request, res: Response) => {
   const valueType = String(req.body.valueType ?? '')
   if (!(SPEC_VALUE_TYPES as readonly string[]).includes(valueType)) {
      throw new AppError('The kind of value must be CHOICE, NUMBER or TEXT', 400)
   }
   const body = pick(req.body, SPEC_FIELDS)
   body.name ??= ''
   checkSpec(body, valueType)
   body.valueType = valueType
   body.key = await uniqueKey(VehicleSpec, keyOf(req.body.key, body.name.fr) || 'spec')
   const spec = await createDoc<IVehicleSpec>(req, VehicleSpec, body, { entityType: ENTITY.SPEC })
   return sendResponse(res, 201, 'Specification added', { spec: present(spec, specFields) })
})

/** The key and the kind of value are fixed once made: vehicles store values by them. */
export const updateSpec = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const current = isValidObjectId(req.params.id) ? await VehicleSpec.findById(req.params.id).select('valueType') : null
   if (!current) return next(notFound(ENTITY.SPEC))
   const body = pick(req.body, SPEC_FIELDS)
   checkSpec(body, current.valueType)
   const spec = await updateDoc<IVehicleSpec>(req, VehicleSpec, req.params.id, body, { entityType: ENTITY.SPEC })
   return sendResponse(res, 200, 'Specification saved', { spec: present(spec, specFields) })
})

export const deleteSpec = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!isValidObjectId(req.params.id)) return next(notFound(ENTITY.SPEC))
   refuseInUse(await SaleVehicle.countDocuments({ 'specs.spec': req.params.id }), 'specification')
   await deleteDoc(req, VehicleSpec, { _id: req.params.id }, { entityType: ENTITY.SPEC })
   return sendResponse(res, 200, 'Specification deleted', {})
})

// --- accessories

const ACCESSORY_FIELDS = ['name', 'group', 'sortOrder', 'isActive'] as const

const checkAccessory = (body: Record<string, any>) => {
   checkListEntry(body)
   if (body.group !== undefined) body.group = localizedIn(body.group, 'Group', 80)
}

export const listAccessories = listOf(VehicleAccessory, accessoryFields, () => usage('accessories', 'accessories'))

export const createAccessory = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, ACCESSORY_FIELDS)
   body.name ??= ''
   checkAccessory(body)
   body.key = await uniqueKey(VehicleAccessory, keyOf(req.body.key, body.name.fr) || 'accessory')
   const accessory = await createDoc<IVehicleAccessory>(req, VehicleAccessory, body, { entityType: ENTITY.ACCESSORY })
   return sendResponse(res, 201, 'Accessory added', { accessory: present(accessory, accessoryFields) })
})

/** The key is fixed once made: the website's links filter by it. */
export const updateAccessory = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, ACCESSORY_FIELDS)
   checkAccessory(body)
   const accessory = await updateDoc<IVehicleAccessory>(req, VehicleAccessory, req.params.id, body, {
      entityType: ENTITY.ACCESSORY,
   })
   return sendResponse(res, 200, 'Accessory saved', { accessory: present(accessory, accessoryFields) })
})

export const deleteAccessory = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!isValidObjectId(req.params.id)) return next(notFound(ENTITY.ACCESSORY))
   refuseInUse(await SaleVehicle.countDocuments({ accessories: req.params.id }), 'accessory')
   await deleteDoc(req, VehicleAccessory, { _id: req.params.id }, { entityType: ENTITY.ACCESSORY })
   return sendResponse(res, 200, 'Accessory deleted', {})
})

/** POST /vehicle-sales/catalogue/starter — the common list, only what is missing. */
export const addStarter = catchAsync(async (req: Request, res: Response) => {
   const added = await addStarterCatalogue()
   await recordAudit(req, {
      action: AUDIT_ACTIONS.CREATE,
      entityType: 'VehicleCatalogue',
      entityId: 'starter',
      after: added,
      reason: 'Common list of types, specifications and accessories added',
   })
   return sendResponse(res, 200, 'Common list added', { added })
})

// ================================================================= parkings

const parkingFields: FieldMap<IParking> = {
   id: (p) => p._id.toString(),
   name: (p) => everyLocale(p.name),
   displayName: (p) => resolveLocalized(p.name),
   slug: (p) => p.slug,
   city: (p) => p.city,
   address: (p) => p.address,
   geo: (p) => geoPoint(p.geo),
   phone: (p) => p.phone ?? '',
   openingHours: (p) => everyLocale(p.openingHours),
   description: (p) => everyLocale(p.description),
   images: (p) => p.images ?? [],
   /** Ids; the names are the types list's. */
   vehicleTypes: (p) => (p.vehicleTypes ?? []).map(String),
   // The id, whether or not the record was read with its supplier alongside.
   supplier: (p) => ((p.supplier as any)?._id ?? p.supplier)?.toString(),
   supplierName: (p) => (p.supplier as any)?.name,
   status: (p) => p.status,
   publishBlockers: (p) => (typeof p.publishBlockers === 'function' ? p.publishBlockers() : []),
   version: (p) => (p as any).__v,
   createdAt: (p) => p.createdAt,
   updatedAt: (p) => p.updatedAt,
}

const presentParking = (p: IParking) => present(p, parkingFields)

/** What the body may set; slug, status and createdBy never. Only what it carries is checked. */
const parkingInput = async (raw: any, creating: boolean) => {
   const body: Record<string, any> = {}
   if (creating || raw.name !== undefined) body.name = localizedIn(raw.name, 'Name', 120, true)
   if (raw.description !== undefined) body.description = localizedIn(raw.description, 'Description', 4000)
   if (raw.openingHours !== undefined) body.openingHours = localizedIn(raw.openingHours, 'Opening hours', 300)
   if (creating || raw.city !== undefined) body.city = text(raw.city, 'Town', 80, true)
   if (raw.address !== undefined) body.address = text(raw.address, 'Address', 300)
   if (raw.phone !== undefined) body.phone = text(raw.phone, 'Phone', 40)
   if (raw.images !== undefined) body.images = images(raw.images)
   if (raw.vehicleTypes !== undefined) {
      const ids = Array.isArray(raw.vehicleTypes) ? [...new Set(raw.vehicleTypes.map(String))] : null
      if (!ids || ids.some((id) => !isValidObjectId(id)) || (await VehicleType.countDocuments({ _id: { $in: ids } })) !== ids.length) {
         throw new AppError('Types of vehicles: choose them from the list', 400)
      }
      body.vehicleTypes = ids
   }
   body.geo = parseGeo(raw.geo)
   body.supplier = await supplierRef(raw.supplier)
   return body
}

export const listParkings = catchAsync(async (req: Request, res: Response) => {
   const { status, city } = req.query
   const filter: Record<string, any> = { status: status ? String(status) : { $ne: LISTING_STATUS.ARCHIVED } }
   if (city) filter.city = String(city)
   const rx = searchRx(req.query.q)
   if (rx) filter.$or = [...LOCALES.map((l) => ({ [`name.${l}`]: rx })), { city: rx }, { slug: rx }, { address: rx }]
   const { items, ...paging } = await paginate<IParking>(Parking, filter, req, {
      populate: 'supplier',
      ...sortBy(req.query.sort, { name: 'name.fr', city: 'city', status: 'status', updated: 'updatedAt' }),
   })
   const counts = await vehicleCounts(items.map((p) => p._id))
   return sendResponse(res, 200, 'OK', {
      items: items.map((p) => ({ ...presentParking(p), vehicleCount: counts.get(String(p._id)) ?? 0 })),
      ...paging,
   })
})

/** Vehicles at each parking, archived ones aside. */
const vehicleCounts = async (ids: unknown[]) => {
   const rows = await SaleVehicle.aggregate([
      { $match: { parking: { $in: ids }, status: { $ne: LISTING_STATUS.ARCHIVED } } },
      { $group: { _id: '$parking', n: { $sum: 1 } } },
   ])
   return new Map(rows.map((r: any) => [String(r._id), r.n as number]))
}

const withCount = async (p: IParking) => ({
   ...presentParking(p),
   vehicleCount: (await vehicleCounts([p._id])).get(String(p._id)) ?? 0,
})

export const getParking = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const parking = isValidObjectId(req.params.id) ? await Parking.findById(req.params.id).populate('supplier') : null
   if (!parking) return next(notFound(ENTITY.PARKING))
   return sendResponse(res, 200, 'OK', { parking: await withCount(parking) })
})

export const createParking = catchAsync(async (req: Request, res: Response) => {
   const body = await parkingInput(req.body ?? {}, true)
   body.slug = await uniqueSlug(Parking, [body.name.fr, body.city])
   body.createdBy = (req as any).admin._id
   const parking = await createDoc<IParking>(req, Parking, body, { entityType: ENTITY.PARKING })
   return sendResponse(res, 201, 'Parking created', { parking: presentParking(parking) })
})

export const updateParking = catchAsync(async (req: Request, res: Response) => {
   const body = await parkingInput(req.body ?? {}, false)
   const parking = await updateDoc<IParking>(req, Parking, req.params.id, body, { entityType: ENTITY.PARKING })
   return sendResponse(res, 200, 'Parking updated', { parking: presentParking(parking) })
})

/** Server-side, as restaurants: the form shows the same blockers. */
export const publishParking = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const parking = isValidObjectId(req.params.id) ? await Parking.findById(req.params.id) : null
   if (!parking) return next(notFound(ENTITY.PARKING))
   if (parking.status === LISTING_STATUS.ARCHIVED) return next(new AppError('An archived parking cannot be published', 409))
   const blockers = parking.publishBlockers()
   if (blockers.length) return next(new AppError(`Cannot publish: ${blockers.join('; ')}`, 400))
   const updated = await updateDoc<IParking>(req, Parking, req.params.id, { status: LISTING_STATUS.PUBLISHED }, {
      entityType: ENTITY.PARKING,
   })
   return sendResponse(res, 200, 'Parking published', { parking: presentParking(updated) })
})

/** Off the website, its vehicles with it (the public reaches them only through a published parking). */
export const deactivateParking = catchAsync(async (req: Request, res: Response) => {
   const parking = await deactivateDoc<IParking>(req, Parking, req.params.id, { entityType: ENTITY.PARKING })
   return sendResponse(res, 200, 'Parking deactivated', { parking: presentParking(parking) })
})

/** Archiving the parking archives its vehicles, as a restaurant's menu goes with it. */
export const archiveParking = catchAsync(async (req: Request, res: Response) => {
   const parking = await archiveDoc<IParking>(req, Parking, req.params.id, { entityType: ENTITY.PARKING })
   await SaleVehicle.updateMany({ parking: parking._id }, { $set: { status: LISTING_STATUS.ARCHIVED } })
   return sendResponse(res, 200, 'Parking archived', { parking: presentParking(parking) })
})

// ================================================================= vehicles

const vehicleFields: FieldMap<ISaleVehicle> = {
   id: (v) => v._id.toString(),
   stockRef: (v) => v.stockRef,
   displayName: (v) => vehicleLabel(v),
   parkingId: (v) => String((v.parking as any)?._id ?? v.parking),
   // Read with the vehicle where the screen needs it.
   parking: (v: any) =>
      v.parking?._id
         ? { id: String(v.parking._id), slug: v.parking.slug, name: resolveLocalized(v.parking.name), city: v.parking.city }
         : undefined,
   vehicleTypeId: (v) => String((v.vehicleType as any)?._id ?? v.vehicleType),
   vehicleType: (v: any) =>
      v.vehicleType?._id
         ? { id: String(v.vehicleType._id), slug: v.vehicleType.slug, name: resolveLocalized(v.vehicleType.name) }
         : undefined,
   make: (v) => v.make,
   model: (v) => v.model,
   year: (v) => v.year ?? null,
   mileageKm: (v) => v.mileageKm ?? null,
   condition: (v) => v.condition,
   colour: (v) => v.colour ?? '',
   title: (v) => everyLocale(v.title),
   description: (v) => everyLocale(v.description),
   // Admin surface only.
   vin: (v) => v.vin ?? '',
   costPrice: (v) => v.costPrice,
   sellPrice: (v) => v.sellPrice,
   // Charged once per booking, whatever the quantity; 0 = in the sell price. Francs, as sellPrice.
   processingFee: (v) => ({ CDF: baseAmount(v.processingFee) }),
   marginBase: (v) => baseAmount(v.sellPrice) - baseAmount(v.costPrice),
   // A promotion (display only): the old price in francs, and its last day.
   promoCompareAtPrice: (v) => ({ CDF: baseAmount(v.promoCompareAtPrice) }),
   promoEndsAt: (v) => (v.promoEndsAt ? new Date(v.promoEndsAt).toISOString().slice(0, 10) : null),
   images: (v) => v.images ?? [],
   videoUrl: (v) => v.videoUrl,
   specs: (v) =>
      (v.specs ?? []).map((s: any) => ({
         spec: String(s.spec?._id ?? s.spec),
         choice: s.choice ?? undefined,
         number: s.number ?? undefined,
         text: s.text ? everyLocale(s.text) : undefined,
      })),
   accessories: (v) => (v.accessories ?? []).map(String),
   status: (v) => v.status,
   // Moved by orders only: shown, never edited.
   availability: (v) => v.availability,
   reservedOrder: (v: any) =>
      v.reservedOrder
         ? v.reservedOrder._id
            ? { id: String(v.reservedOrder._id), reference: v.reservedOrder.reference, status: v.reservedOrder.status }
            : { id: String(v.reservedOrder) }
         : undefined,
   soldAt: (v) => v.soldAt,
   publishBlockers: (v) => vehicleBlockers(v),
   version: (v) => (v as any).__v,
   createdAt: (v) => v.createdAt,
   updatedAt: (v) => v.updatedAt,
}

const presentVehicle = (v: ISaleVehicle) => present(v, vehicleFields)

const vehicleBlockers = (v: Partial<ISaleVehicle>) => {
   const blockers: string[] = []
   if (!v.make || !v.model) blockers.push('Make and model are required')
   if (!(baseAmount(v.sellPrice) > 0)) blockers.push('A sell price in francs is required')
   if (!v.images?.length) blockers.push('At least one photo is required')
   return blockers
}

/**
 * Specifications as sent: `[{ spec, choice | number | text }]`. A blank value
 * is "not set" and dropped; a choice must be one of the spec's, a number a
 * number, a text per language.
 */
const parseSpecs = async (raw: unknown) => {
   if (!Array.isArray(raw) || raw.length > 60) throw new AppError('Specifications: a list of 60 at most', 400)
   const ids = raw.map((e: any) => String(e?.spec ?? ''))
   if (ids.some((id) => !isValidObjectId(id))) throw new AppError('Specifications: choose them from the list', 400)
   const defs = new Map((await VehicleSpec.find({ _id: { $in: ids } }).lean()).map((d) => [String(d._id), d]))
   const out: Record<string, unknown>[] = []
   const seen = new Set<string>()
   for (const e of raw as any[]) {
      const def = defs.get(String(e.spec))
      if (!def) throw new AppError('Specifications: choose them from the list', 400)
      if (seen.has(String(def._id))) continue
      seen.add(String(def._id))
      const name = resolveLocalized(def.name)
      if (def.valueType === 'CHOICE') {
         if (e.choice === undefined || e.choice === null || e.choice === '') continue
         if (!def.choices.some((c) => c.key === e.choice)) throw new AppError(`${name}: choose one of its values`, 400)
         out.push({ spec: def._id, choice: e.choice })
      } else if (def.valueType === 'NUMBER') {
         if (e.number === undefined || e.number === null || e.number === '') continue
         const n = Number(e.number)
         if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new AppError(`${name} must be a number`, 400)
         out.push({ spec: def._id, number: n })
      } else {
         const t = localizedIn(e.text, name, 500)
         if (Object.keys(t).length) out.push({ spec: def._id, text: t })
      }
   }
   return out
}

/** The parking and type: both from the lists, and the type one the parking holds (when it names any). */
const checkPlacement = async (parkingId: unknown, typeId: unknown) => {
   const parking = isValidObjectId(parkingId) ? await Parking.findById(parkingId).select('vehicleTypes status') : null
   if (!parking || parking.status === LISTING_STATUS.ARCHIVED) throw new AppError('Choose a parking from the list', 400)
   if (!isValidObjectId(typeId) || !(await VehicleType.exists({ _id: typeId }))) {
      throw new AppError('Choose a type of vehicle from the list', 400)
   }
   if (parking.vehicleTypes.length && !parking.vehicleTypes.some((t) => String(t) === String(typeId))) {
      throw new AppError('This parking does not hold that type of vehicle: add the type to the parking first', 400, 'TYPE_NOT_AT_PARKING')
   }
}

/**
 * What the body may set. Never stockRef, status, availability, reservedOrder
 * or soldAt. Prices and the promotion are handled by the callers, as dishes'.
 */
const vehicleInput = async (raw: any, creating: boolean) => {
   const body: Record<string, any> = {}
   if (creating || raw.make !== undefined) body.make = text(raw.make, 'Make', 60, true)
   if (creating || raw.model !== undefined) body.model = text(raw.model, 'Model', 60, true)
   if (raw.colour !== undefined) body.colour = text(raw.colour, 'Colour', 40)
   if (raw.vin !== undefined) body.vin = text(raw.vin, 'VIN', 40).toUpperCase()
   if (raw.parking !== undefined) body.parking = String(raw.parking)
   if (raw.vehicleType !== undefined) body.vehicleType = String(raw.vehicleType)
   if (raw.year !== undefined) body.year = whole(raw.year, 'Year', 1900, 2100)
   if (raw.mileageKm !== undefined) body.mileageKm = whole(raw.mileageKm, 'Mileage', 0, 5_000_000)
   if (raw.condition !== undefined) {
      if (!(VEHICLE_CONDITIONS as readonly string[]).includes(raw.condition)) throw new AppError('Condition must be NEW or USED', 400)
      body.condition = raw.condition
   }
   if (raw.title !== undefined) body.title = localizedIn(raw.title, 'Title', 120)
   if (raw.description !== undefined) body.description = localizedIn(raw.description, 'Description', 6000)
   if (raw.images !== undefined) body.images = images(raw.images)
   if (raw.videoUrl !== undefined) body.videoUrl = raw.videoUrl
   if (raw.specs !== undefined) body.specs = await parseSpecs(raw.specs)
   if (raw.accessories !== undefined) {
      const ids = Array.isArray(raw.accessories) ? [...new Set(raw.accessories.map(String))] : null
      if (!ids || ids.some((id) => !isValidObjectId(id)) || (await VehicleAccessory.countDocuments({ _id: { $in: ids } })) !== ids.length) {
         throw new AppError('Accessories: choose them from the list', 400)
      }
      body.accessories = ids
   }
   return body
}

/** Read with what the screens show beside it. */
const withRefs = (query: any) =>
   query
      .populate('parking', 'slug name city')
      .populate('vehicleType', 'slug name')
      .populate('reservedOrder', 'reference status')

const findVehicle = (id: string) => (isValidObjectId(id) ? withRefs(SaleVehicle.findById(id)) : Promise.resolve(null))

export const listVehicles = catchAsync(async (req: Request, res: Response) => {
   const q = req.query
   const filter: Record<string, any> = { status: q.status ? String(q.status) : { $ne: LISTING_STATUS.ARCHIVED } }
   if (q.availability) filter.availability = String(q.availability)
   if (q.parking) filter.parking = isValidObjectId(q.parking) ? String(q.parking) : null
   else if (q.city) filter.parking = { $in: await Parking.distinct('_id', { city: String(q.city) }) }
   if (q.type) {
      // An id, or a slug.
      const type = isValidObjectId(q.type) ? String(q.type) : (await VehicleType.findOne({ slug: String(q.type) }).select('_id'))?._id
      filter.vehicleType = type ?? null
   }
   const rx = searchRx(q.q)
   if (rx) {
      filter.$or = [
         { stockRef: rx },
         { make: rx },
         { model: rx },
         { vin: rx },
         ...LOCALES.map((l) => ({ [`title.${l}`]: rx })),
      ]
   }
   const { items, ...paging } = await paginate<ISaleVehicle>(SaleVehicle, filter, req, {
      populate: 'parking vehicleType reservedOrder',
      ...sortBy(q.sort, {
         stockRef: 'stockRef',
         vehicle: ['make', 'model', 'year'],
         year: 'year',
         mileage: 'mileageKm',
         price: 'sellPrice.CDF',
         status: 'status',
         availability: 'availability',
         updated: 'updatedAt',
      }),
   })
   return sendResponse(res, 200, 'OK', { items: presentList(items, vehicleFields), ...paging })
})

export const getVehicle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const vehicle = await findVehicle(req.params.id)
   if (!vehicle) return next(notFound(ENTITY.VEHICLE))
   return sendResponse(res, 200, 'OK', { vehicle: presentVehicle(vehicle) })
})

export const createVehicle = catchAsync(async (req: Request, res: Response) => {
   const raw = req.body ?? {}
   const data = await vehicleInput(raw, true)
   await checkPlacement(data.parking, data.vehicleType)
   // Both prices, in francs, as a dish's: the cost is what margin reporting reads.
   data.costPrice = parseMoney(raw.costPrice)
   data.sellPrice = parseMoney(raw.sellPrice)
   if (data.costPrice?.CDF === undefined) throw new AppError('Enter the cost price in FC', 400)
   if (!(data.sellPrice?.CDF > 0)) throw new AppError('The sell price must be more than 0 FC', 400)
   data.processingFee = parseFee(raw.processingFee)
   applyPromotion(raw, data)
   data.createdBy = (req as any).admin._id

   // Two saves can reach for the same next reference: the unique index refuses one, which takes the next.
   for (let attempt = 0; ; attempt++) {
      try {
         const created = await createDoc<ISaleVehicle>(
            req,
            SaleVehicle,
            { ...data, stockRef: await nextStockRef() },
            { entityType: ENTITY.VEHICLE }
         )
         const vehicle = await findVehicle(String(created._id))
         return sendResponse(res, 201, 'Vehicle created', { vehicle: presentVehicle(vehicle) })
      } catch (err: any) {
         if (err?.code !== 11000 || !err?.keyPattern?.stockRef || attempt >= 4) throw err
      }
   }
})

export const updateVehicle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const raw = req.body ?? {}
   const current = isValidObjectId(req.params.id) ? await SaleVehicle.findById(req.params.id) : null
   if (!current) return next(notFound(ENTITY.VEHICLE))
   const patch = await vehicleInput(raw, false)
   // The form sends both on every save: checked only when one changes, so a
   // parking whose types were edited since does not block the vehicle's other edits.
   const parking = patch.parking ?? String(current.parking)
   const type = patch.vehicleType ?? String(current.vehicleType)
   if (parking !== String(current.parking) || type !== String(current.vehicleType)) await checkPlacement(parking, type)
   // A blank price box (`{}`) leaves that price as it is: both are required.
   const cost = parseMoney(raw.costPrice)
   if (cost?.CDF !== undefined) patch.costPrice = cost
   const sell = parseMoney(raw.sellPrice)
   if (sell?.CDF !== undefined) {
      if (!(sell.CDF > 0)) return next(new AppError('The sell price must be more than 0 FC', 400))
      patch.sellPrice = sell
   }
   patch.processingFee = parseFee(raw.processingFee)
   if (touchesPromotion(raw)) applyPromotion(raw, patch, current)
   await updateDoc<ISaleVehicle>(req, SaleVehicle, req.params.id, patch, { entityType: ENTITY.VEHICLE })
   return sendResponse(res, 200, 'Vehicle updated', { vehicle: presentVehicle(await findVehicle(req.params.id)) })
})

export const publishVehicle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const vehicle = isValidObjectId(req.params.id) ? await SaleVehicle.findById(req.params.id) : null
   if (!vehicle) return next(notFound(ENTITY.VEHICLE))
   if (vehicle.status === LISTING_STATUS.ARCHIVED) return next(new AppError('An archived vehicle cannot be published', 409))
   const blockers = vehicleBlockers(vehicle)
   if (blockers.length) return next(new AppError(`Cannot publish: ${blockers.join('; ')}`, 400))
   await updateDoc(req, SaleVehicle, req.params.id, { status: LISTING_STATUS.PUBLISHED }, { entityType: ENTITY.VEHICLE })
   return sendResponse(res, 200, 'Vehicle published', { vehicle: presentVehicle(await findVehicle(req.params.id)) })
})

export const deactivateVehicle = catchAsync(async (req: Request, res: Response) => {
   await deactivateDoc(req, SaleVehicle, req.params.id, { entityType: ENTITY.VEHICLE })
   return sendResponse(res, 200, 'Vehicle deactivated', { vehicle: presentVehicle(await findVehicle(req.params.id)) })
})

/** Out of the lists and off the website; an order that reserved or bought it keeps its own copy. */
export const archiveVehicle = catchAsync(async (req: Request, res: Response) => {
   await archiveDoc(req, SaleVehicle, req.params.id, { entityType: ENTITY.VEHICLE })
   return sendResponse(res, 200, 'Vehicle archived', { vehicle: presentVehicle(await findVehicle(req.params.id)) })
})
