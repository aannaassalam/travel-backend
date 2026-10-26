import { NextFunction, Request, Response } from 'express'
import { isValidObjectId } from 'mongoose'
import slugify from 'slugify'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { LISTING_STATUS, LOCALES } from '../../constants/domain.constants'
import {
   presentHotel,
   presentHotels,
   presentRoomType,
   presentRoomTypes,
} from '../../dto/admin/inventory.dto'
import { Hotel, RatePlan, RoomType } from '../../model/hotelModel'
import { baseAmount, parseGeo, parseMoney, resolveLocalized } from '../../model/shared.schema'
import { supplierRef } from './supplierController'
import {
   archiveDoc,
   confirmOverOpenBookings,
   deleteDoc,
   createDoc,
   deactivateDoc,
   paginate,
   sortBy,
   translatedCount,
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
   'videoUrl',
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
   'mealPlan',
] as const

/**
 * A room type's nightly price, as sent: francs only, for every future night. The
 * same rule as any listing — a cost, and a sell price above it — because a
 * room sold below cost is a loss on every night of every stay.
 */
const roomPrices = (body: any, patch: Record<string, any>) => {
   if (body.costPrice !== undefined) patch.costPrice = parseMoney(body.costPrice)
   if (body.sellPrice !== undefined) patch.sellPrice = parseMoney(body.sellPrice)
   if (patch.sellPrice === undefined && patch.costPrice === undefined) return patch
   const sell = baseAmount(patch.sellPrice)
   const cost = baseAmount(patch.costPrice)
   if (sell <= 0) throw new AppError('Enter the nightly sell price in francs (FC)', 400)
   if (cost <= 0) throw new AppError('Enter the nightly cost price in francs (FC)', 400)
   if (sell <= cost) throw new AppError('The sell price must be above the cost price', 400)
   return patch
}

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

   const { items, ...paging } = await paginate(
      Hotel,
      filter,
      req,
      // One key per column of the panel's hotels table.
      { populate: 'supplier', ...sortBy(req.query.sort, {
         name: 'name.fr',
         city: 'city',
         status: 'status',
         translations: { value: translatedCount('name', LOCALES) },
         supplier: 'supplier',
         updated: 'updatedAt',
      }) }
   )
   return sendResponse(res, 200, 'OK', {
      items: presentHotels(items as any),
      ...paging,
   })
})

export const getHotel = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const hotel = await Hotel.findById(req.params.id).populate('supplier')
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
         supplier: await supplierRef(req.body.supplier),
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
      {
         ...pick(req.body, HOTEL_EDITABLE),
         supplier: await supplierRef(req.body.supplier),
         geo: parseGeo(req.body.geo),
      },
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
      // A hotel with no priced room has nothing a customer could book.
      const priced = await RoomType.exists({
         hotel: hotel._id,
         status: LISTING_STATUS.PUBLISHED,
         'sellPrice.CDF': { $gt: 0 },
      })
      if (!priced) blockers.push('Add at least one room type with its nightly price')
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

/** Off the website and unbookable, but still in the list — publish to undo. */
export const deactivateHotel = catchAsync(async (req: Request, res: Response) => {
   const hotel = await deactivateDoc<any>(req, Hotel, req.params.id, {
      entityType: ENTITY,
   })
   return sendResponse(res, 200, 'Hotel deactivated', {
      hotel: presentHotel(hotel),
   })
})

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
      // Earned by the original, not by a copy nobody has stayed in.
      delete copy.rating
      copy.reviewCount = 0
      // Its reviews stay with the original, and so does the rating they make.
      delete copy.reviewStats
      copy.name = req.body.name || {
         ...source.name,
         fr: `${resolveLocalized(source.name)} (copie)`,
      }
      copy.slug = await uniqueSlug(Hotel, [resolveLocalized(copy.name), copy.city])
      // A clone always starts inactive — never silently publish a copy.
      copy.status = LISTING_STATUS.INACTIVE
      copy.createdBy = (req as any).admin._id

      const hotel = await createDoc<any>(req, Hotel, copy, { entityType: ENTITY })

      // Room types come along, otherwise the clone is useless for hotels.
      // Archived ones stay behind: they were deleted from the original.
      const sourceRooms = await RoomType.find({
         hotel: source._id,
         status: { $ne: LISTING_STATUS.ARCHIVED },
      })
      for (const room of sourceRooms) {
         const r = room.toObject() as any
         delete r._id
         delete r.__v
         r.hotel = hotel._id
         await RoomType.create(r)
      }
      if (sourceRooms.length) {
         // One entry for the rooms — written, so audited (§2.2).
         await recordAudit(req, {
            action: AUDIT_ACTIONS.CREATE,
            entityType: 'RoomType',
            entityId: hotel._id.toString(),
            after: { copiedFrom: source.slug, roomTypes: sourceRooms.length },
            reason: `Room types copied with the hotel (${sourceRooms.length})`,
         })
      }

      return sendResponse(res, 201, 'Hotel duplicated', {
         hotel: presentHotel(hotel),
      })
   }
)

// --- Room types -------------------------------------------------------------

export const createRoomType = catchAsync(async (req: Request, res: Response) => {
   // The hotel can have been deleted since this page was opened: a room type
   // (and then its prices) stored under it would belong to nothing.
   if (!isValidObjectId(req.params.id) || !(await Hotel.exists({ _id: req.params.id }))) {
      throw new AppError(`${ENTITY} not found`, 404)
   }
   const roomType = await createDoc<any>(
      req,
      RoomType,
      {
         ...roomPrices(req.body, pick(req.body, ROOMTYPE_EDITABLE)),
         hotel: req.params.id,
         // Decided here, never taken from the body (§BUG-010). A room type has
         // no publish step of its own, so it is live once saved; whether a
         // customer sees it is the hotel's status.
         status: LISTING_STATUS.PUBLISHED,
      },
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
      roomPrices(req.body, pick(req.body, ROOMTYPE_EDITABLE)),
      { entityType: 'RoomType' }
   )
   return sendResponse(res, 200, 'Room type updated', {
      roomType: presentRoomType(roomType),
   })
})

/**
 * DELETE /hotels/:id — for good, with what cannot stand without it: its room
 * types and every night's price and allotment. Bookings keep their own copy
 * of the stay they sold.
 */
export const deleteHotel = catchAsync(async (req: Request, res: Response) => {
   await confirmOverOpenBookings(req, { 'items.listingId': req.params.id }, 'this hotel')
   const hotel = await Hotel.findById(req.params.id)
   if (!hotel) throw new AppError(`${ENTITY} not found`, 404)
   const rooms = await RoomType.find({ hotel: hotel._id }).lean()
   const nights = await RatePlan.countDocuments({ hotel: hotel._id })
   await deleteDoc(req, Hotel, { _id: hotel._id }, {
      entityType: ENTITY,
      snapshot: (before) => ({ ...before, roomTypes: rooms }),
      reason: `Deleted with ${rooms.length} room type(s) and ${nights} nightly price(s)`,
      // The rooms before the hotel: stopped half way, what is left is a hotel
      // that can be deleted again — not rooms and prices belonging to nothing.
      withIt: async () => {
         await RatePlan.deleteMany({ hotel: hotel._id })
         await RoomType.deleteMany({ hotel: hotel._id })
      },
   })
   return sendResponse(res, 200, 'Hotel deleted', {})
})

/** DELETE /hotels/:id/room-types/:roomTypeId — the room type and its nightly prices. */
export const deleteRoomType = catchAsync(async (req: Request, res: Response) => {
   const own = { _id: req.params.roomTypeId, hotel: req.params.id }
   await confirmOverOpenBookings(req, { 'items.roomTypeId': req.params.roomTypeId }, 'this room type')
   const nights = await RatePlan.countDocuments({ roomType: req.params.roomTypeId })
   await deleteDoc(req, RoomType, own, {
      entityType: 'RoomType',
      reason: `Deleted with ${nights} nightly price(s)`,
      withIt: () => RatePlan.deleteMany({ roomType: req.params.roomTypeId }),
   })
   return sendResponse(res, 200, 'Room type deleted', {})
})
