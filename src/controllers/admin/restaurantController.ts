import { NextFunction, Request, Response } from 'express'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { LISTING_STATUS, LOCALES, MENU_SECTIONS } from '../../constants/domain.constants'
import {
   presentMenuItem,
   presentMenuItems,
   presentRestaurant,
   presentRestaurants,
} from '../../dto/admin/inventory.dto'
import { MenuItem, Restaurant } from '../../model/restaurantModel'
import { baseAmount, parseGeo, parseMoney, resolveLocalized } from '../../model/shared.schema'
import {
   archiveDoc,
   createDoc,
   deactivateDoc,
   paginate,
   updateDoc,
} from '../../services/adminCrud.service'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { pick } from '../../utils/pick'
import { sendResponse } from '../../utils/response'
import { uniqueSlug } from '../../utils/uniqueSlug'

/**
 * §BUG-010: fields a caller may set. geo/deliveryZones are parsed and written
 * explicitly; slug, status, createdBy, rating and reviewCount never from the body.
 */
const RESTAURANT_EDITABLE = [
   'name',
   'description',
   'cuisines',
   'address',
   'city',
   'country',
   'images',
   'openingHours',
   'prepTimeMinutes',
   'phone',
] as const

/** §BUG-010: costPrice/sellPrice parsed explicitly; restaurant/status never from body. */
const MENUITEM_EDITABLE = [
   'section',
   'name',
   'description',
   'images',
   'isAvailable',
   'sortOrder',
] as const

/**
 * Restaurants and their menus, admin side.
 *
 * Mirrors the hotel controller deliberately — same CRUD service, same audit
 * entity pattern, same archive-never-delete rule (§5.1). A menu item is to a
 * restaurant what a room type is to a hotel, so the shapes match and neither
 * needs learning twice.
 */

const ENTITY = 'Restaurant'
const MENU_ENTITY = 'MenuItem'

/** Free-text search box: NUL stripped (the driver throws on it) and capped so a pasted paragraph never becomes a regex. */
const searchTerm = (v: unknown) =>
   typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, 80) : ''
const searchRx = (value: string) =>
   new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

/** Declared order, not alphabetical — see the public controller for why. */
const SECTION_RANK = Object.values(MENU_SECTIONS).reduce<Record<string, number>>(
   (acc, s, i) => ({ ...acc, [s]: i }),
   {}
)

export const listRestaurants = catchAsync(async (req: Request, res: Response) => {
   const { status, city, q } = req.query
   const filter: Record<string, any> = {}
   // Archived records stay in the database forever but out of the way.
   filter.status = status ? status : { $ne: LISTING_STATUS.ARCHIVED }
   if (city) filter.city = city
   // Search every locale, not only the default one — plus city, slug, cuisine.
   const term = searchTerm(q)
   if (term) {
      const rx = searchRx(term)
      filter.$or = [
         ...LOCALES.map((l) => ({ [`name.${l}`]: rx })),
         { city: rx },
         { slug: rx },
         { cuisines: rx },
      ]
   }

   const { items, nextCursor } = await paginate(Restaurant, filter, req)
   return sendResponse(res, 200, 'OK', {
      items: presentRestaurants(items as any),
      nextCursor,
   })
})

export const getRestaurant = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const restaurant = await Restaurant.findById(req.params.id)
      if (!restaurant) return next(new AppError('Restaurant not found', 404))

      // The menu comes back with the record: the edit screen is one page, and
      // a second round trip for it would only add a spinner.
      const menu = (await MenuItem.find({ restaurant: restaurant._id })).sort(
         (a, b) =>
            (SECTION_RANK[a.section] ?? 99) - (SECTION_RANK[b.section] ?? 99) ||
            (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
      )
      return sendResponse(res, 200, 'OK', {
         restaurant: presentRestaurant(restaurant),
         menu: presentMenuItems(menu),
      })
   }
)

export const createRestaurant = catchAsync(async (req: Request, res: Response) => {
   const { name, city } = req.body
   const restaurant = await createDoc<any>(
      req,
      Restaurant,
      {
         ...pick(req.body, RESTAURANT_EDITABLE),
         geo: parseGeo(req.body.geo),
         deliveryZones: parseZones(req.body.deliveryZones),
         slug: await uniqueSlug(Restaurant, [resolveLocalized(name), city]),
         createdBy: (req as any).admin._id,
      },
      { entityType: ENTITY }
   )
   return sendResponse(res, 201, 'Restaurant created', {
      restaurant: presentRestaurant(restaurant),
   })
})

export const updateRestaurant = catchAsync(async (req: Request, res: Response) => {
   const patch: Record<string, unknown> = pick(req.body, RESTAURANT_EDITABLE)
   // Only rewrite zones when the form actually sent them, so a PATCH of the
   // opening hours does not silently wipe the delivery table.
   if (req.body.deliveryZones !== undefined) {
      patch.deliveryZones = parseZones(req.body.deliveryZones)
   }
   patch.geo = parseGeo(req.body.geo)
   const restaurant = await updateDoc<any>(req, Restaurant, req.params.id, patch, {
      entityType: ENTITY,
   })
   return sendResponse(res, 200, 'Restaurant updated', {
      restaurant: presentRestaurant(restaurant),
   })
})

/** §5.1: validate before publish, server-side rather than only in the form. */
export const publishRestaurant = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const restaurant = await Restaurant.findById(req.params.id)
      if (!restaurant) return next(new AppError('Restaurant not found', 404))

      const blockers = restaurant.publishBlockers()
      if (blockers.length) {
         return next(new AppError(`Cannot publish: ${blockers.join('; ')}`, 400))
      }

      // A restaurant with nothing to sell is a page that says "menu" and lists
      // nothing. Checked here rather than in publishBlockers because it is the
      // one blocker that lives on a different collection.
      const sellable = await MenuItem.countDocuments({
         restaurant: restaurant._id,
         status: LISTING_STATUS.PUBLISHED,
      })
      if (!sellable) {
         return next(new AppError('Cannot publish: publish at least one menu item first', 400))
      }

      const updated = await updateDoc<any>(
         req,
         Restaurant,
         req.params.id,
         { status: LISTING_STATUS.PUBLISHED },
         { entityType: ENTITY }
      )
      return sendResponse(res, 200, 'Restaurant published', {
         restaurant: presentRestaurant(updated),
      })
   }
)

export const archiveRestaurant = catchAsync(async (req: Request, res: Response) => {
   const restaurant = await archiveDoc<any>(req, Restaurant, req.params.id, {
      entityType: ENTITY,
   })
   // Archiving the restaurant has to take the menu with it, or the dishes stay
   // PUBLISHED and remain priceable at checkout for a restaurant that is gone.
   await MenuItem.updateMany(
      { restaurant: req.params.id },
      { $set: { status: LISTING_STATUS.ARCHIVED } }
   )
   return sendResponse(res, 200, 'Restaurant archived', {
      restaurant: presentRestaurant(restaurant),
   })
})

/**
 * Off the website, but still in the list — publish to undo. The menu is left
 * exactly as it is: the public menu is only ever reached through a published
 * restaurant, and checkout refuses a dish whose restaurant is not live, so
 * nothing has to be unpicked (or remembered and restored) on the dishes.
 */
export const deactivateRestaurant = catchAsync(async (req: Request, res: Response) => {
   const restaurant = await deactivateDoc<any>(req, Restaurant, req.params.id, {
      entityType: ENTITY,
   })
   return sendResponse(res, 200, 'Restaurant deactivated', {
      restaurant: presentRestaurant(restaurant),
   })
})

/**
 * §5.1 clone, as hotels and listings have. A second branch, or the same
 * kitchen in another town, is an existing restaurant with a different address —
 * and the menu comes along, or the copy is an empty shell that takes an
 * afternoon to refill.
 */
export const duplicateRestaurant = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const source = await Restaurant.findById(req.params.id)
      if (!source) return next(new AppError('Restaurant not found', 404))

      const copy = source.toObject({ virtuals: false }) as any
      delete copy._id
      delete copy.__v
      delete copy.createdAt
      delete copy.updatedAt
      // Earned by the original, not by a copy that has served nobody.
      delete copy.rating
      copy.reviewCount = 0
      copy.name = {
         ...source.name,
         fr: `${resolveLocalized(source.name)} (copie)`,
      }
      copy.slug = await uniqueSlug(Restaurant, [resolveLocalized(copy.name), copy.city])
      // A clone always starts inactive — never silently publish a copy.
      copy.status = LISTING_STATUS.INACTIVE
      // Fresh zone ids: an order keeps the id of the zone it was delivered to,
      // and two restaurants must not answer to the same one.
      copy.deliveryZones = (copy.deliveryZones ?? []).map(
         ({ _id, id, ...zone }: any) => zone
      )
      copy.createdBy = (req as any).admin._id

      const restaurant = await createDoc<any>(req, Restaurant, copy, {
         entityType: ENTITY,
      })

      // Dishes keep their own status, so a copy of a working menu is one
      // publish away from live; the restaurant being inactive keeps it unseen.
      const dishes = await MenuItem.find({
         restaurant: source._id,
         status: { $ne: LISTING_STATUS.ARCHIVED },
      })
      if (dishes.length) {
         await MenuItem.insertMany(
            dishes.map((dish) => {
               const d = dish.toObject({ virtuals: false }) as any
               delete d._id
               delete d.__v
               delete d.createdAt
               delete d.updatedAt
               d.restaurant = restaurant._id
               return d
            })
         )
         // One entry for the menu — a line per dish would bury the signal.
         await recordAudit(req, {
            action: AUDIT_ACTIONS.CREATE,
            entityType: MENU_ENTITY,
            entityId: restaurant._id.toString(),
            after: { copiedFrom: source.slug, dishes: dishes.length },
            reason: `Menu copied with the restaurant (${dishes.length} dishes)`,
         })
      }

      return sendResponse(res, 201, 'Restaurant duplicated', {
         restaurant: presentRestaurant(restaurant),
      })
   }
)

// --- Menu items -------------------------------------------------------------

export const createMenuItem = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const restaurant = await Restaurant.findById(req.params.id)
      if (!restaurant) return next(new AppError('Restaurant not found', 404))

      const item = await createDoc<any>(
         req,
         MenuItem,
         {
            ...pick(req.body, MENUITEM_EDITABLE),
            restaurant: restaurant._id,
            costPrice: parseMoney(req.body.costPrice),
            sellPrice: parseMoney(req.body.sellPrice),
         },
         { entityType: MENU_ENTITY }
      )
      return sendResponse(res, 201, 'Menu item created', { item: presentMenuItem(item) })
   }
)

export const updateMenuItem = catchAsync(async (req: Request, res: Response) => {
   // §BUG-010: allow-listed — restaurant is excluded, so a dish can never be
   // re-pointed at a different kitchen, and status moves only via archive.
   const patch: Record<string, unknown> = pick(req.body, MENUITEM_EDITABLE)
   // parseMoney drops blanks, so an untouched currency box never becomes 0.
   if (req.body.costPrice !== undefined) patch.costPrice = parseMoney(req.body.costPrice)
   if (req.body.sellPrice !== undefined) patch.sellPrice = parseMoney(req.body.sellPrice)

   const item = await updateDoc<any>(req, MenuItem, req.params.menuItemId, patch, {
      entityType: MENU_ENTITY,
   })
   return sendResponse(res, 200, 'Menu item updated', { item: presentMenuItem(item) })
})

export const archiveMenuItem = catchAsync(async (req: Request, res: Response) => {
   const item = await archiveDoc<any>(req, MenuItem, req.params.menuItemId, {
      entityType: MENU_ENTITY,
   })
   return sendResponse(res, 200, 'Menu item archived', { item: presentMenuItem(item) })
})

/** The dish, only if it belongs to the restaurant named in the URL. */
const ownDish = (req: Request) =>
   MenuItem.findOne({ _id: req.params.menuItemId, restaurant: req.params.id })

/**
 * Puts a dish on the menu customers see.
 *
 * Its own endpoint because status is never taken from a PATCH body (§BUG-010).
 * Before this existed that rule left the panel's publish button doing nothing:
 * every new dish stayed unseen, and a restaurant needs one published dish to go
 * live, so no restaurant added through the panel could ever be published.
 */
export const publishMenuItem = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const dish = await ownDish(req)
      if (!dish) return next(new AppError('Menu item not found', 404))
      if (dish.status === LISTING_STATUS.ARCHIVED) {
         return next(new AppError('An archived dish cannot be published', 409))
      }

      const blockers: string[] = []
      if (!dish.name?.fr) blockers.push('French name is required')
      if (!(baseAmount(dish.sellPrice) > 0)) blockers.push('A USD sell price is required')
      if (blockers.length) {
         return next(new AppError(`Cannot publish: ${blockers.join('; ')}`, 400))
      }

      const item = await updateDoc<any>(
         req,
         MenuItem,
         req.params.menuItemId,
         { status: LISTING_STATUS.PUBLISHED },
         { entityType: MENU_ENTITY }
      )
      return sendResponse(res, 200, 'Menu item published', { item: presentMenuItem(item) })
   }
)

/** Takes a dish off the menu without archiving it. */
export const deactivateMenuItem = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      if (!(await ownDish(req))) return next(new AppError('Menu item not found', 404))
      const item = await deactivateDoc<any>(req, MenuItem, req.params.menuItemId, {
         entityType: MENU_ENTITY,
      })
      return sendResponse(res, 200, 'Menu item deactivated', {
         item: presentMenuItem(item),
      })
   }
)

// ---------------------------------------------------------------------------

/**
 * Normalise the delivery-zone table from the form.
 *
 * Money goes through `parseMoney` for the same reason it does everywhere else:
 * it drops blank boxes rather than turning them into a real 0, and a delivery
 * fee of zero is a very different promise from one that was never typed.
 */
const parseZones = (input: any) => {
   if (!Array.isArray(input)) return undefined
   return input
      .filter((z) => String(z?.name ?? '').trim())
      .slice(0, 30)
      .map((z) => ({
         ...(z.id ? { _id: z.id } : {}),
         name: String(z.name).trim(),
         fee: parseMoney(z.fee),
         minOrder: parseMoney(z.minOrder),
         etaMinutes: Number(z.etaMinutes) || 45,
         isActive: z.isActive !== false,
      }))
}
