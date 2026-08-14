import { NextFunction, Request, Response } from 'express'
import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { VERTICALS } from '../../constants/domain.constants'
import { Listing } from '../../model/listingModel'
import { Location, ServicedRoute } from '../../model/locationModel'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * The screen where the office decides where the business operates.
 *
 * §12/§15: adding a city must not need a developer. Everything the public
 * search box offers comes from here.
 */

const slugify = (s: string) =>
   s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

const present = (l: any) => ({
   id: l._id.toString(),
   name: l.name,
   slug: l.slug,
   country: l.country,
   province: l.province,
   kind: l.kind,
   iata: l.iata,
   aliases: l.aliases,
   servesVerticals: l.servesVerticals,
   isActive: l.isActive,
   sortOrder: l.sortOrder,
   image: l.image,
})

export const listLocations = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, unknown> = {}
   if (req.query.q) filter.name = { $regex: String(req.query.q), $options: 'i' }
   if (req.query.active === 'true') filter.isActive = true
   if (req.query.active === 'false') filter.isActive = false

   const items = await Location.find(filter).sort({ sortOrder: 1, name: 1 }).limit(500)

   /**
    * How many published listings name each place. The office needs this before
    * deactivating somewhere — switching off a city that still has inventory on
    * sale is how a customer ends up holding a booking for a route the site no
    * longer admits to running.
    */
   const counts = await Listing.aggregate([
      { $match: { status: 'PUBLISHED' } },
      { $group: { _id: '$city', n: { $sum: 1 } } },
   ])
   const byName = new Map(counts.map((c: any) => [c._id, c.n]))

   return sendResponse(res, 200, 'OK', {
      items: items.map((l) => ({ ...present(l), listingCount: byName.get(l.name) ?? 0 })),
   })
})

export const createLocation = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const name = String(req.body?.name ?? '').trim()
      if (!name) return next(new AppError('A name is required', 400))

      const slug = String(req.body?.slug ?? '').trim() || slugify(name)
      if (await Location.findOne({ slug })) {
         return next(new AppError('A location with that slug already exists', 409))
      }

      const location = await Location.create({
         name,
         slug,
         country: req.body?.country || 'CD',
         province: req.body?.province,
         kind: req.body?.kind || 'CITY',
         // Blank rather than null: an empty string fails the IATA pattern.
         iata: req.body?.iata ? String(req.body.iata).toUpperCase() : undefined,
         aliases: Array.isArray(req.body?.aliases) ? req.body.aliases : [],
         servesVerticals: (Array.isArray(req.body?.servesVerticals)
            ? req.body.servesVerticals
            : []
         ).filter((v: string) => Object.values(VERTICALS).includes(v as never)),
         isActive: req.body?.isActive !== false,
         sortOrder: Number(req.body?.sortOrder) || 0,
         image: req.body?.image,
      })

      await recordAudit(req, {
         action: AUDIT_ACTIONS.CREATE,
         entityType: 'Location',
         entityId: location._id.toString(),
         after: location.toObject(),
      })
      return sendResponse(res, 201, 'Location created', { location: present(location) })
   }
)

export const updateLocation = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const location = await Location.findById(req.params.id)
      if (!location) return next(new AppError('Location not found', 404))
      const before = location.toObject()

      const fields = [
         'name',
         'province',
         'country',
         'kind',
         'aliases',
         'servesVerticals',
         'isActive',
         'sortOrder',
         'image',
      ] as const
      for (const f of fields) {
         if (req.body?.[f] !== undefined) (location as any)[f] = req.body[f]
      }
      // Cleared explicitly rather than set to '', which would fail validation.
      if (req.body?.iata !== undefined) {
         location.iata = req.body.iata ? String(req.body.iata).toUpperCase() : undefined
      }
      await location.save()

      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'Location',
         entityId: location._id.toString(),
         before,
         after: location.toObject(),
         reason: req.body?.reason,
      })
      return sendResponse(res, 200, 'Location saved', { location: present(location) })
   }
)

/* ------------------------------------------------------------------- routes */

const presentRoute = (r: any) => ({
   id: r._id.toString(),
   vertical: r.vertical,
   origin: r.origin ? present(r.origin) : null,
   destination: r.destination ? present(r.destination) : null,
   isActive: r.isActive,
})

export const listRoutes = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, unknown> = {}
   if (req.query.vertical) filter.vertical = String(req.query.vertical).toUpperCase()
   const items = await ServicedRoute.find(filter)
      .populate('origin destination')
      .sort({ vertical: 1 })
      .limit(2000)
   return sendResponse(res, 200, 'OK', { items: items.map(presentRoute) })
})

export const createRoute = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { vertical, originId, destinationId } = req.body ?? {}
      if (vertical !== VERTICALS.FLIGHT && vertical !== VERTICALS.BUS) {
         return next(new AppError('Routes apply to flights and buses only', 400))
      }
      if (!originId || !destinationId || originId === destinationId) {
         return next(new AppError('Pick two different locations', 400))
      }
      const [origin, destination] = await Promise.all([
         Location.findById(originId),
         Location.findById(destinationId),
      ])
      if (!origin || !destination) return next(new AppError('Unknown location', 404))

      const existing = await ServicedRoute.findOne({
         vertical,
         origin: origin._id,
         destination: destination._id,
      })
      if (existing) {
         // Re-adding a route that was switched off should turn it back on
         // rather than fail on the unique index.
         existing.isActive = true
         await existing.save()
         await existing.populate('origin destination')
         return sendResponse(res, 200, 'Route re-enabled', { route: presentRoute(existing) })
      }

      const route = await ServicedRoute.create({
         vertical,
         origin: origin._id,
         destination: destination._id,
      })
      await route.populate('origin destination')

      await recordAudit(req, {
         action: AUDIT_ACTIONS.CREATE,
         entityType: 'ServicedRoute',
         entityId: route._id.toString(),
         after: { vertical, origin: origin.name, destination: destination.name },
      })
      return sendResponse(res, 201, 'Route added', { route: presentRoute(route) })
   }
)

export const updateRoute = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const route = await ServicedRoute.findById(req.params.id)
      if (!route) return next(new AppError('Route not found', 404))
      if (req.body?.isActive !== undefined) route.isActive = Boolean(req.body.isActive)
      await route.save()
      await route.populate('origin destination')

      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'ServicedRoute',
         entityId: route._id.toString(),
         after: { isActive: route.isActive },
      })
      return sendResponse(res, 200, 'Route saved', { route: presentRoute(route) })
   }
)
