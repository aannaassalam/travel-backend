import { NextFunction, Request, Response } from 'express'
import { HydratedDocument, isValidObjectId } from 'mongoose'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { LOCALES } from '../../constants/domain.constants'
import { Driver, IDriver } from '../../model/driverModel'
import { NOTIFICATION_EVENTS } from '../../model/enquiryModel'
import { Ride, RIDE_STATUS } from '../../model/rideModel'
import { baseAmount, Localized, parseMoney } from '../../model/shared.schema'
import { ITransferPlace, PLACE_KINDS, TransferPlace } from '../../model/transferPlaceModel'
import { IVehicleCategory, VehicleCategory } from '../../model/vehicleCategoryModel'
import { IVehicle, Vehicle } from '../../model/vehicleModel'
import { createDoc, deleteDoc, updateDoc } from '../../services/adminCrud.service'
import { recordAudit } from '../../services/auditLog.service'
import { notify } from '../../services/notifications/notify.service'
import { availableDrivers } from '../../services/transfers/availability'
import { driverPortalLink } from '../../services/transfers/rideVars'
import { hashPassword, MIN_PASSWORD_LENGTH } from '../../middleware/customerAuth'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { isOwnPublicFile } from '../../utils/ownFile'
import { pick } from '../../utils/pick'
import { FieldMap, present, presentList } from '../../utils/present'
import { sendResponse } from '../../utils/response'
import { sameName } from '../../utils/sameName'
import { normalisePhone } from '../public/customerAuthController'

/**
 * The fleet, under Transfers in the panel: vehicle categories and their
 * prices, the vehicles, the drivers, and the saved pick-up places. Inventory
 * permissions — a car is stock like a hotel room — and the same write path as
 * suppliers and partners (adminCrud: audit log, version/409).
 */

/** Where every transfer picture goes; the upload route pins it, the saves check it. */
export const TRANSFER_FOLDER = 'transfers'
const IMAGE_EXT = '(\\.[a-z0-9]{1,5})?'
const OPEN = [RIDE_STATUS.PENDING, RIDE_STATUS.ASSIGNED, RIDE_STATUS.STARTED]

// ------------------------------------------------------------- shared checks

const text = (raw: unknown, label: string, max: number, required = false) => {
   if (raw === undefined || raw === null) {
      if (required) throw new AppError(`${label} is required`, 400)
      return ''
   }
   if (typeof raw !== 'string') throw new AppError(`${label} must be text`, 400)
   const v = raw.replace(/\0/g, '').trim()
   if (required && !v) throw new AppError(`${label} is required`, 400)
   if (v.length > max) throw new AppError(`${label} is limited to ${max} characters`, 400)
   return v
}

/** fr/en/pt/es from the form; French required where the record needs a name. */
const localizedInput = (raw: any, label: string, max: number, frRequired: boolean): Localized => {
   const src = typeof raw === 'string' ? { fr: raw } : raw
   if (!src || typeof src !== 'object' || Array.isArray(src)) throw new AppError(`${label} must have a French text`, 400)
   const out: Localized = {}
   for (const l of LOCALES) out[l] = text(src[l], `${label} (${l})`, max)
   if (frRequired && !out.fr) throw new AppError(`${label}: the French text is required`, 400)
   return out
}

/** A whole number in range, or 400; `null` clears an optional one. */
const whole = (raw: unknown, label: string, min: number, max: number, optional = false) => {
   if (optional && (raw === null || raw === '')) return null
   const n = Number(raw)
   if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`${label} must be a whole number from ${min} to ${max}`, 400)
   return n
}

const orderNumber = (raw: unknown) => {
   const n = raw === '' || raw === null ? NaN : Number(raw)
   if (!Number.isFinite(n)) throw new AppError('The order must be a number', 400)
   return n
}

/** A picture: the one this screen's upload answered with, or blank. */
const image = (raw: unknown, label: string) => {
   if (raw === null || raw === '') return ''
   if (!isOwnPublicFile(raw, TRANSFER_FOLDER, IMAGE_EXT)) throw new AppError(`${label}: upload the picture from this screen`, 400)
   return raw
}

const notFound = (what: string) => new AppError(`${what} not found`, 404)

// ================================================================ categories

const CATEGORY = 'VehicleCategory'
const CATEGORY_FIELDS = [
   'name', 'description', 'image', 'seats', 'luggage',
   'pricePerKm', 'pricePerHour', 'minimumFare', 'costPerKm', 'costPerHour',
   'sortOrder', 'isActive',
] as const

const categoryFields: FieldMap<IVehicleCategory> = {
   id: (c) => c._id.toString(),
   name: (c) => c.name,
   description: (c) => c.description,
   image: (c) => c.image,
   seats: (c) => c.seats,
   luggage: (c) => c.luggage,
   pricePerKm: (c) => c.pricePerKm,
   pricePerHour: (c) => c.pricePerHour,
   minimumFare: (c) => c.minimumFare,
   // Admin surface only: what the office pays.
   costPerKm: (c) => c.costPerKm,
   costPerHour: (c) => c.costPerHour,
   sortOrder: (c) => c.sortOrder,
   isActive: (c) => c.isActive,
   version: (c) => (c as any).__v,
   updatedAt: (c) => c.updatedAt,
}

/** Each refusal names the box to fix. Only what the body carries is checked. */
export const checkCategory = (body: Record<string, any>) => {
   if (body.name !== undefined) body.name = localizedInput(body.name, 'Name', 120, true)
   if (body.description !== undefined) body.description = localizedInput(body.description, 'Description', 2000, false)
   if (body.image !== undefined) body.image = image(body.image, 'Picture')
   if (body.seats !== undefined) body.seats = whole(body.seats, 'Seats', 1, 60)
   if (body.luggage !== undefined) body.luggage = text(body.luggage, 'Luggage', 120)
   for (const key of ['pricePerKm', 'pricePerHour', 'minimumFare', 'costPerKm', 'costPerHour'] as const) {
      if (body[key] !== undefined) body[key] = parseMoney(body[key]) ?? {}
   }
   if (body.sortOrder !== undefined) body.sortOrder = orderNumber(body.sortOrder)
   if (body.isActive !== undefined) body.isActive = Boolean(body.isActive)
}

/** An active category has to sell something: a price per km or per hour. */
export const assertSellable = (c: { isActive?: boolean; pricePerKm?: any; pricePerHour?: any }) => {
   if (c.isActive !== false && baseAmount(c.pricePerKm) <= 0 && baseAmount(c.pricePerHour) <= 0) {
      throw new AppError('An active category needs a price per km or a price per hour', 400, 'CATEGORY_UNPRICED')
   }
}

/** GET /transfers/categories — all of them, with how many vehicles each has. */
export const listCategories = catchAsync(async (_req: Request, res: Response) => {
   const [items, counts] = await Promise.all([
      VehicleCategory.find().sort({ sortOrder: 1, 'name.fr': 1 }).limit(200),
      Vehicle.aggregate([{ $group: { _id: '$category', n: { $sum: 1 } } }]),
   ])
   const byCategory = new Map(counts.map((c: any) => [String(c._id), c.n]))
   return sendResponse(res, 200, 'OK', {
      items: items.map((c) => ({ ...present(c, categoryFields), vehicleCount: byCategory.get(String(c._id)) ?? 0 })),
   })
})

export const createCategory = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, CATEGORY_FIELDS)
   body.name ??= ''
   body.seats ??= ''
   checkCategory(body)
   assertSellable(body)
   const category = await createDoc<IVehicleCategory>(req, VehicleCategory, body, { entityType: CATEGORY })
   return sendResponse(res, 201, 'Category added', { category: present(category, categoryFields) })
})

export const updateCategory = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const body = pick(req.body, CATEGORY_FIELDS)
   checkCategory(body)
   const current = await VehicleCategory.findById(req.params.id)
   if (!current) return next(notFound('Category'))
   assertSellable({ ...current.toObject(), ...body })
   const category = await updateDoc<IVehicleCategory>(req, VehicleCategory, req.params.id, body, { entityType: CATEGORY })
   return sendResponse(res, 200, 'Category saved', { category: present(category, categoryFields) })
})

/** DELETE /transfers/categories/:id — refused while a vehicle is of it; rides keep their own copy of the name. */
export const deleteCategory = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!isValidObjectId(req.params.id)) return next(notFound('Category'))
   const vehicles = await Vehicle.countDocuments({ category: req.params.id })
   if (vehicles) {
      return next(
         new AppError(`${vehicles} vehicle${vehicles === 1 ? ' is' : 's are'} of this category. Move or delete them first.`, 409, 'CATEGORY_IN_USE')
      )
   }
   await deleteDoc(req, VehicleCategory, { _id: req.params.id }, { entityType: CATEGORY })
   return sendResponse(res, 200, 'Category deleted', {})
})

// ================================================================== vehicles

const VEHICLE = 'Vehicle'
const VEHICLE_FIELDS = ['city', 'category', 'make', 'model', 'year', 'color', 'plate', 'seats', 'image', 'isActive'] as const

const vehicleFields: FieldMap<IVehicle> = {
   id: (v) => v._id.toString(),
   city: (v) => v.city,
   category: (v: any) =>
      v.category && typeof v.category === 'object'
         ? { id: v.category._id.toString(), name: v.category.name, seats: v.category.seats }
         : undefined,
   categoryId: (v: any) => String(v.category?._id ?? v.category),
   make: (v) => v.make,
   model: (v) => v.model,
   year: (v) => v.year,
   color: (v) => v.color,
   plate: (v) => v.plate,
   seats: (v) => v.seats,
   image: (v) => v.image,
   isActive: (v) => v.isActive,
   version: (v) => (v as any).__v,
   updatedAt: (v) => v.updatedAt,
}

export const checkVehicle = async (body: Record<string, any>) => {
   if (body.city !== undefined) body.city = text(body.city, 'City', 80, true)
   if (body.category !== undefined) {
      if (!isValidObjectId(body.category) || !(await VehicleCategory.exists({ _id: body.category }))) {
         throw new AppError('Choose a vehicle category', 400)
      }
   }
   if (body.make !== undefined) body.make = text(body.make, 'Make', 60, true)
   if (body.model !== undefined) body.model = text(body.model, 'Model', 60, true)
   if (body.year !== undefined) body.year = whole(body.year, 'Year', 1950, 2100, true)
   if (body.color !== undefined) body.color = text(body.color, 'Colour', 40)
   if (body.plate !== undefined) body.plate = text(body.plate, 'Plate', 20, true).toUpperCase()
   if (body.seats !== undefined) body.seats = whole(body.seats, 'Seats', 1, 60, true)
   if (body.image !== undefined) body.image = image(body.image, 'Picture')
   if (body.isActive !== undefined) body.isActive = Boolean(body.isActive)
}

/** GET /transfers/vehicles?city=&category=&active= */
export const listVehicles = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, unknown> = {}
   const city = text(req.query.city, 'City', 80)
   if (city) filter.city = sameName(city)
   if (isValidObjectId(req.query.category)) filter.category = req.query.category
   if (req.query.active === 'true') filter.isActive = true
   if (req.query.active === 'false') filter.isActive = false
   const items = await Vehicle.find(filter)
      .populate('category', 'name seats')
      .collation({ locale: 'fr', strength: 1 })
      .sort({ city: 1, plate: 1 })
      .limit(1000)
   return sendResponse(res, 200, 'OK', { items: presentList(items, vehicleFields) })
})

export const createVehicle = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, VEHICLE_FIELDS)
   for (const key of ['city', 'make', 'model', 'plate'] as const) body[key] ??= ''
   body.category ??= ''
   await checkVehicle(body)
   const vehicle = await createDoc<HydratedDocument<IVehicle>>(req, Vehicle, body, { entityType: VEHICLE })
   await vehicle.populate('category', 'name seats')
   return sendResponse(res, 201, 'Vehicle added', { vehicle: present(vehicle, vehicleFields) })
})

export const updateVehicle = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, VEHICLE_FIELDS)
   await checkVehicle(body)
   const vehicle = await updateDoc<HydratedDocument<IVehicle>>(req, Vehicle, req.params.id, body, { entityType: VEHICLE })
   await vehicle.populate('category', 'name seats')
   return sendResponse(res, 200, 'Vehicle saved', { vehicle: present(vehicle, vehicleFields) })
})

/** DELETE /transfers/vehicles/:id — not while a ride is booked on it; its drivers are unlinked. */
export const deleteVehicle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!isValidObjectId(req.params.id)) return next(notFound('Vehicle'))
   const open = await Ride.countDocuments({ vehicle: req.params.id, status: { $in: OPEN } })
   if (open) return next(new AppError(`${open} ride${open === 1 ? ' is' : 's are'} booked on this vehicle`, 409, 'VEHICLE_IN_USE'))
   await deleteDoc(req, Vehicle, { _id: req.params.id }, {
      entityType: VEHICLE,
      withIt: () => Driver.updateMany({ vehicle: req.params.id }, { $unset: { vehicle: 1 } }),
   })
   return sendResponse(res, 200, 'Vehicle deleted', {})
})

// =================================================================== drivers

const DRIVER = 'Driver'
const DRIVER_FIELDS = ['name', 'phone', 'city', 'photo', 'licenceNumber', 'vehicle', 'isActive'] as const

const driverFields: FieldMap<IDriver> = {
   id: (d) => d._id.toString(),
   name: (d) => d.name,
   phone: (d) => d.phone,
   city: (d) => d.city,
   photo: (d) => d.photo,
   licenceNumber: (d) => d.licenceNumber,
   vehicle: (d: any) =>
      d.vehicle && typeof d.vehicle === 'object'
         ? { id: d.vehicle._id.toString(), make: d.vehicle.make, model: d.vehicle.model, color: d.vehicle.color, plate: d.vehicle.plate, seats: d.vehicle.seats }
         : undefined,
   vehicleId: (d: any) => (d.vehicle ? String(d.vehicle._id ?? d.vehicle) : undefined),
   isActive: (d) => d.isActive,
   ratingStats: (d) => d.ratingStats ?? { rating: 0, count: 0 },
   /** Whether the office has given them a password yet — never the password. */
   hasPassword: (d) => Boolean(d.passwordChangedAt),
   lastSeenAt: (d) => d.lastSeenAt,
   version: (d) => (d as any).__v,
   updatedAt: (d) => d.updatedAt,
}

export const checkDriver = async (body: Record<string, any>) => {
   if (body.name !== undefined) body.name = text(body.name, 'Name', 120, true)
   if (body.phone !== undefined) {
      const phone = normalisePhone(String(body.phone ?? ''))
      if (!phone) throw new AppError('Phone: an international number, for example +243 81 000 00 00', 400)
      body.phone = phone
   }
   if (body.city !== undefined) body.city = text(body.city, 'City', 80, true)
   if (body.photo !== undefined) body.photo = image(body.photo, 'Photo')
   if (body.licenceNumber !== undefined) body.licenceNumber = text(body.licenceNumber, 'Licence number', 60)
   if (body.vehicle !== undefined) {
      if (body.vehicle === null || body.vehicle === '') body.vehicle = null
      else if (!isValidObjectId(body.vehicle) || !(await Vehicle.exists({ _id: body.vehicle }))) {
         throw new AppError('Choose a vehicle from the list', 400)
      }
   }
   if (body.isActive !== undefined) body.isActive = Boolean(body.isActive)
}

/** Drivers out on a ride right now. */
const onRideNow = async () =>
   new Set((await Ride.find({ status: RIDE_STATUS.STARTED }).select('driver').lean()).map((r: any) => String(r.driver)))

/** GET /transfers/drivers?city=&active= */
export const listDrivers = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, unknown> = {}
   const city = text(req.query.city, 'City', 80)
   if (city) filter.city = sameName(city)
   if (req.query.active === 'true') filter.isActive = true
   if (req.query.active === 'false') filter.isActive = false
   const [items, busy] = await Promise.all([
      Driver.find(filter).populate('vehicle').collation({ locale: 'fr', strength: 1 }).sort({ city: 1, name: 1 }).limit(1000),
      onRideNow(),
   ])
   return sendResponse(res, 200, 'OK', {
      items: items.map((d) => ({ ...present(d, driverFields), onRideNow: busy.has(String(d._id)) })),
   })
})

/**
 * GET /transfers/drivers/available?city=&at=&minutes=&except= — who can take a
 * ride at that time, for the assign dialog. `at` as the ride stores it.
 */
export const listAvailableDrivers = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const city = text(req.query.city, 'City', 80)
   const at = new Date(String(req.query.at ?? ''))
   if (!city || Number.isNaN(at.getTime())) return next(new AppError('city and at are required', 400))
   const minutes = Math.min(Math.max(Math.floor(Number(req.query.minutes)) || 60, 1), 24 * 60)
   const except = isValidObjectId(req.query.except) ? String(req.query.except) : undefined
   const rows = await availableDrivers(city, at, minutes, except)
   return sendResponse(res, 200, 'OK', {
      items: rows.map(({ driver, busy, onRideNow: now }) => ({ ...present(driver, driverFields), busy, onRideNow: now })),
   })
})

export const createDriver = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, DRIVER_FIELDS)
   for (const key of ['name', 'phone', 'city'] as const) body[key] ??= ''
   await checkDriver(body)
   const driver = await createDoc<IDriver>(req, Driver, body, { entityType: DRIVER })
   await driver.populate('vehicle')
   // The portal's address; the password is given by the office, never texted.
   const link = driverPortalLink()
   void notify({
      event: NOTIFICATION_EVENTS.DRIVER_WELCOME,
      recipient: driver.phone,
      vars: { driver_name: driver.name, ride_link: link },
      appendIfMissing: link ? { token: '{{ride_link}}', text: `\n${link}` } : undefined,
   })
   return sendResponse(res, 201, 'Driver added', { driver: present(driver, driverFields) })
})

export const updateDriver = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, DRIVER_FIELDS)
   await checkDriver(body)
   const driver = await updateDoc<IDriver>(req, Driver, req.params.id, body, { entityType: DRIVER })
   await driver.populate('vehicle')
   return sendResponse(res, 200, 'Driver saved', { driver: present(driver, driverFields) })
})

/** POST /transfers/drivers/:id/password { password } — set or reset; every session they had ends. */
export const setDriverPassword = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const driver = await Driver.findById(req.params.id)
   if (!driver) return next(notFound('Driver'))
   const password = String(req.body?.password ?? '')
   if (password.length < MIN_PASSWORD_LENGTH) {
      return next(new AppError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400, 'PASSWORD_WEAK'))
   }
   await Driver.updateOne(
      { _id: driver._id },
      { $set: { password: await hashPassword(password), passwordChangedAt: new Date() } }
   )
   // Logged as an event, not a diff: the hash is nobody's to read back.
   await recordAudit(req, {
      action: AUDIT_ACTIONS.UPDATE,
      entityType: DRIVER,
      entityId: driver._id.toString(),
      reason: 'Driver password set',
   })
   return sendResponse(res, 200, 'Password set', {})
})

/** DELETE /transfers/drivers/:id — not while a ride is assigned to them. */
export const deleteDriver = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!isValidObjectId(req.params.id)) return next(notFound('Driver'))
   const open = await Ride.countDocuments({
      driver: req.params.id,
      status: { $in: [RIDE_STATUS.ASSIGNED, RIDE_STATUS.STARTED] },
   })
   if (open) return next(new AppError(`${open} ride${open === 1 ? ' is' : 's are'} assigned to this driver. Unassign first.`, 409, 'DRIVER_IN_USE'))
   await deleteDoc(req, Driver, { _id: req.params.id }, {
      entityType: DRIVER,
      // Who it was, for the record; the hash and the rest go.
      snapshot: (d) => ({ _id: d._id, name: d.name, phone: d.phone, city: d.city, isActive: d.isActive, createdAt: d.createdAt }),
   })
   return sendResponse(res, 200, 'Driver deleted', {})
})

// ==================================================================== places

const PLACE = 'TransferPlace'
const PLACE_FIELDS = ['city', 'name', 'kind', 'lat', 'lng', 'isActive', 'sortOrder'] as const

const placeFields: FieldMap<ITransferPlace> = {
   id: (p) => p._id.toString(),
   city: (p) => p.city,
   name: (p) => p.name,
   kind: (p) => p.kind,
   lat: (p) => p.lat,
   lng: (p) => p.lng,
   isActive: (p) => p.isActive,
   sortOrder: (p) => p.sortOrder,
   version: (p) => (p as any).__v,
   updatedAt: (p) => p.updatedAt,
}

export const checkPlace = (body: Record<string, any>) => {
   if (body.city !== undefined) body.city = text(body.city, 'City', 80, true)
   if (body.name !== undefined) body.name = localizedInput(body.name, 'Name', 200, true)
   if (body.kind !== undefined && !(PLACE_KINDS as readonly string[]).includes(body.kind)) {
      throw new AppError(`Kind must be one of: ${PLACE_KINDS.join(', ')}`, 400)
   }
   for (const [key, limit] of [['lat', 90], ['lng', 180]] as const) {
      if (body[key] !== undefined) {
         const n = Number(body[key])
         if (!Number.isFinite(n) || Math.abs(n) > limit) throw new AppError('Set the point on the map', 400)
         body[key] = n
      }
   }
   if (body.isActive !== undefined) body.isActive = Boolean(body.isActive)
   if (body.sortOrder !== undefined) body.sortOrder = orderNumber(body.sortOrder)
}

/** GET /transfers/places?city= */
export const listPlaces = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, unknown> = {}
   const city = text(req.query.city, 'City', 80)
   if (city) filter.city = sameName(city)
   const items = await TransferPlace.find(filter).sort({ city: 1, sortOrder: 1, 'name.fr': 1 }).limit(1000)
   return sendResponse(res, 200, 'OK', { items: presentList(items, placeFields) })
})

export const createPlace = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, PLACE_FIELDS)
   body.city ??= ''
   body.name ??= ''
   body.lat ??= ''
   body.lng ??= ''
   checkPlace(body)
   const place = await createDoc<ITransferPlace>(req, TransferPlace, body, { entityType: PLACE })
   return sendResponse(res, 201, 'Place added', { place: present(place, placeFields) })
})

export const updatePlace = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, PLACE_FIELDS)
   checkPlace(body)
   const place = await updateDoc<ITransferPlace>(req, TransferPlace, req.params.id, body, { entityType: PLACE })
   return sendResponse(res, 200, 'Place saved', { place: present(place, placeFields) })
})

/** DELETE /transfers/places/:id — rides keep the label and the pin they were booked with. */
export const deletePlace = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   if (!isValidObjectId(req.params.id)) return next(notFound('Place'))
   await deleteDoc(req, TransferPlace, { _id: req.params.id }, { entityType: PLACE })
   return sendResponse(res, 200, 'Place deleted', {})
})

// =================================================================== uploads

/**
 * In front of the shared upload handler on POST /transfers/uploads: pictures of
 * categories, vehicles and drivers — public, in this folder and nowhere else.
 */
export const transferImagesOnly = (req: Request, _res: Response, next: NextFunction) => {
   req.body = { ...req.body, folder: TRANSFER_FOLDER, visibility: 'public' }
   next()
}
