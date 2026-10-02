import { NextFunction, Request, Response } from 'express'
import slugify from 'slugify'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { LISTING_STATUS, LOCALES } from '../../constants/domain.constants'
import {
   presentHotel,
   presentHotels,
   presentRatePlans,
   presentRoomType,
   presentRoomTypes,
} from '../../dto/admin/inventory.dto'
import { Hotel, RatePlan, RoomType } from '../../model/hotelModel'
import { baseAmount, parseGeo, parseMoney, resolveLocalized } from '../../model/shared.schema'
import { getSettings } from '../../model/settingsModel'
import {
   archiveDoc,
   createDoc,
   paginate,
   updateDoc,
} from '../../services/adminCrud.service'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { pick } from '../../utils/pick'
import { sendResponse } from '../../utils/response'
import { uniqueSlug } from '../../utils/uniqueSlug'

const ENTITY = 'Hotel'

/**
 * §BUG-010: fields a caller may set. geo is parsed and written explicitly;
 * slug, status, createdBy, rating and reviewCount are never taken from the body.
 */
const HOTEL_EDITABLE = [
   'name',
   'description',
   'stars',
   'address',
   'city',
   'country',
   'amenities',
   'images',
   'supplier',
   'checkInTime',
   'checkOutTime',
   'policies',
] as const

/** §BUG-010: `hotel` comes from the route, status/_id never from the body. */
const ROOMTYPE_EDITABLE = [
   'name',
   'description',
   'maxAdults',
   'maxChildren',
   'beds',
   'amenities',
   'images',
   'sizeSqm',
] as const

/** Free-text search box: NUL stripped (the driver throws on it) and capped so a pasted paragraph never becomes a regex. */
const searchTerm = (v: unknown) =>
   typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, 80) : ''
const searchRx = (value: string) =>
   new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

export const listHotels = catchAsync(async (req: Request, res: Response) => {
   const { status, city, q } = req.query
   const filter: Record<string, any> = {}
   // Archived listings stay in the database forever but are out of the way.
   filter.status = status ? status : { $ne: LISTING_STATUS.ARCHIVED }
   if (city) filter.city = city
   // Search every locale, not just the default one — plus city and slug.
   const term = searchTerm(q)
   if (term) {
      const rx = searchRx(term)
      filter.$or = [
         ...LOCALES.map((l) => ({ [`name.${l}`]: rx })),
         { city: rx },
         { slug: rx },
      ]
   }

   const { items, nextCursor } = await paginate(Hotel, filter, req)
   return sendResponse(res, 200, 'OK', {
      items: presentHotels(items as any),
      nextCursor,
   })
})

export const getHotel = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const hotel = await Hotel.findById(req.params.id)
      if (!hotel) return next(new AppError('Hotel not found', 404))
      const roomTypes = await RoomType.find({
         hotel: hotel._id,
         status: { $ne: LISTING_STATUS.ARCHIVED },
      })
      return sendResponse(res, 200, 'OK', {
         hotel: presentHotel(hotel),
         roomTypes: presentRoomTypes(roomTypes),
      })
   }
)

export const createHotel = catchAsync(async (req: Request, res: Response) => {
   const { name, city } = req.body
   const hotel = await createDoc<any>(
      req,
      Hotel,
      {
         ...pick(req.body, HOTEL_EDITABLE),
         geo: parseGeo(req.body.geo),
         slug: await uniqueSlug(Hotel, [resolveLocalized(name), city]),
         createdBy: (req as any).admin._id,
      },
      { entityType: ENTITY }
   )
   return sendResponse(res, 201, 'Hotel created', { hotel: presentHotel(hotel) })
})

export const updateHotel = catchAsync(async (req: Request, res: Response) => {
   const hotel = await updateDoc<any>(
      req,
      Hotel,
      req.params.id,
      { ...pick(req.body, HOTEL_EDITABLE), geo: parseGeo(req.body.geo) },
      { entityType: ENTITY }
   )
   return sendResponse(res, 200, 'Hotel updated', { hotel: presentHotel(hotel) })
})

/** §5.1: validate before publish, server-side. */
export const publishHotel = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const hotel = await Hotel.findById(req.params.id)
      if (!hotel) return next(new AppError('Hotel not found', 404))

      const blockers = (hotel as any).publishBlockers()
      if (blockers.length) {
         return next(
            new AppError(`Cannot publish: ${blockers.join('; ')}`, 400)
         )
      }
      return sendResponse(
         res,
         200,
         'Hotel published',
         {
            hotel: presentHotel(
               await updateDoc<any>(
                  req,
                  Hotel,
                  req.params.id,
                  { status: LISTING_STATUS.PUBLISHED },
                  { entityType: ENTITY }
               )
            ),
         }
      )
   }
)

export const archiveHotel = catchAsync(async (req: Request, res: Response) => {
   const hotel = await archiveDoc<any>(req, Hotel, req.params.id, {
      entityType: ENTITY,
   })
   return sendResponse(res, 200, 'Hotel archived', {
      hotel: presentHotel(hotel),
   })
})

/**
 * §5.1: "Duplicate" and "Duplicate with new dates" on every listing. Most
 * inventory is a variation of yesterday's — the guide calls clone the
 * highest-leverage item in the module, likely halving data-entry time.
 */
export const duplicateHotel = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const source = await Hotel.findById(req.params.id)
      if (!source) return next(new AppError('Hotel not found', 404))

      const copy = source.toObject() as any
      delete copy._id
      delete copy.__v
      delete copy.createdAt
      delete copy.updatedAt
      copy.name = req.body.name || {
         ...source.name,
         fr: `${resolveLocalized(source.name)} (copie)`,
      }
      copy.slug = await uniqueSlug(Hotel, [resolveLocalized(copy.name), copy.city])
      // A clone always starts as a draft — never silently publish a copy.
      copy.status = LISTING_STATUS.DRAFT

      const hotel = await createDoc<any>(req, Hotel, copy, { entityType: ENTITY })

      // Room types come along, otherwise the clone is useless for hotels.
      const sourceRooms = await RoomType.find({ hotel: source._id })
      for (const room of sourceRooms) {
         const r = room.toObject() as any
         delete r._id
         delete r.__v
         r.hotel = hotel._id
         await RoomType.create(r)
      }

      return sendResponse(res, 201, 'Hotel duplicated', {
         hotel: presentHotel(hotel),
      })
   }
)

// --- Room types -------------------------------------------------------------

export const createRoomType = catchAsync(async (req: Request, res: Response) => {
   const roomType = await createDoc<any>(
      req,
      RoomType,
      { ...pick(req.body, ROOMTYPE_EDITABLE), hotel: req.params.id },
      { entityType: 'RoomType' }
   )
   return sendResponse(res, 201, 'Room type created', {
      roomType: presentRoomType(roomType),
   })
})

export const updateRoomType = catchAsync(async (req: Request, res: Response) => {
   const roomType = await updateDoc<any>(
      req,
      RoomType,
      req.params.roomTypeId,
      pick(req.body, ROOMTYPE_EDITABLE),
      { entityType: 'RoomType' }
   )
   return sendResponse(res, 200, 'Room type updated', {
      roomType: presentRoomType(roomType),
   })
})

// --- Availability calendar (§5.3) -------------------------------------------

/** Reads the grid: room types as rows, dates as columns. */
export const getCalendar = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { from, to } = req.query
      if (!from || !to) {
         return next(new AppError('from and to dates are required', 400))
      }
      const start = new Date(String(from))
      const end = new Date(String(to))
      // Bounded like every other list endpoint (§2.2) — a year-wide grid would
      // be both unusable and a heavy query.
      const days = (end.getTime() - start.getTime()) / 86400000
      if (!(days >= 0) || days > 92) {
         return next(new AppError('Date range must be between 0 and 92 days', 400))
      }

      const roomTypes = await RoomType.find({
         hotel: req.params.id,
         status: { $ne: LISTING_STATUS.ARCHIVED },
      })
      const cells = await RatePlan.find({
         hotel: req.params.id,
         date: { $gte: start, $lte: end },
      })

      return sendResponse(res, 200, 'OK', {
         roomTypes: presentRoomTypes(roomTypes),
         cells: presentRatePlans(cells),
      })
   }
)

/**
 * §5.3: bulk-set price or allotment across a drag-selected range.
 *
 * Entering 30 nights one form at a time is unusable (§5.2), so this is the
 * write path the grid uses. One audit entry for the whole operation rather than
 * one per night — 90 rows of noise would bury the signal.
 */
export const bulkUpdateCalendar = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { roomTypeId, from, to, costPrice, sellPrice, allotment, mealPlan, blocked } =
         req.body

      if (!roomTypeId || !from || !to) {
         return next(new AppError('roomTypeId, from and to are required', 400))
      }
      const sellMoney = parseMoney(sellPrice)
      const costMoney = parseMoney(costPrice)
      if (
         sellPrice !== undefined &&
         costPrice !== undefined &&
         baseAmount(sellMoney) < baseAmount(costMoney)
      ) {
         // §5.1 publish validation, applied at write time so it cannot be
         // dodged by editing after publishing.
         return next(new AppError('Sell price must be above cost price', 400))
      }

      const roomType = await RoomType.findById(roomTypeId)
      if (!roomType) return next(new AppError('Room type not found', 404))

      const start = new Date(String(from))
      const end = new Date(String(to))
      const dates: Date[] = []
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
         dates.push(new Date(d))
      }
      if (!dates.length || dates.length > 366) {
         return next(new AppError('Invalid date range', 400))
      }

      /**
       * §5.1 price-change guard: an edit moving a published price by more than
       * the configured threshold needs typed confirmation. A mis-keyed price
       * that gets purchased is genuinely painful to unwind with no refunds.
       */
      const settings = await getSettings()
      const guard = settings.priceChangeGuardPercent
      if (sellPrice !== undefined && !req.body.confirmPriceChange) {
         const existing = await RatePlan.find({
            roomType: roomTypeId,
            date: { $gte: start, $lte: end },
            'sellPrice.USD': { $gt: 0 },
         })
         // Compared in the base currency, the one price every night has.
         const nextBase = baseAmount(sellMoney)
         const breached = existing.find((cell) => {
            const currentBase = baseAmount(cell.sellPrice)
            if (!currentBase) return false
            return (Math.abs(nextBase - currentBase) / currentBase) * 100 > guard
         })
         if (breached) {
            return next(
               new AppError(
                  `This changes an existing price by more than ${guard}%. Resend with confirmPriceChange to proceed.`,
                  409
               )
            )
         }
      }

      const set: Record<string, any> = {}
      if (costPrice !== undefined) set.costPrice = costMoney
      if (sellPrice !== undefined) set.sellPrice = sellMoney
      if (allotment !== undefined) set.allotment = allotment
      if (mealPlan !== undefined) set.mealPlan = mealPlan
      if (blocked !== undefined) set.blocked = blocked

      /**
       * Defaults for a night that does not exist yet. MongoDB rejects an update
       * where $set and $setOnInsert touch the same path ("would create a
       * conflict"), so anything already in $set is excluded here — required
       * fields the caller did omit still get a value on insert.
       */
      const setOnInsert: Record<string, any> = { hotel: req.params.id }
      if (set.costPrice === undefined) setOnInsert.costPrice = { USD: 0 }
      if (set.sellPrice === undefined) setOnInsert.sellPrice = { USD: 0 }
      if (set.allotment === undefined) setOnInsert.allotment = 0

      // Upsert: a night with no row yet is created, an existing one is patched.
      // Cast: hotel/roomType arrive as route+body strings; Mongoose casts
      // them to ObjectId at write time, which its bulkWrite types don't model.
      await RatePlan.bulkWrite(
         dates.map((date) => ({
            updateOne: {
               filter: { roomType: roomTypeId, date },
               update: { $set: set, $setOnInsert: setOnInsert },
               upsert: true,
            },
         })) as any
      )

      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'RatePlan',
         entityId: String(roomTypeId),
         after: { ...set, from, to, nights: dates.length },
         reason: req.body.reason,
      })

      const cells = await RatePlan.find({
         roomType: roomTypeId,
         date: { $gte: start, $lte: end },
      })
      return sendResponse(res, 200, `${dates.length} night(s) updated`, {
         cells: presentRatePlans(cells),
      })
   }
)
