import { Request, Response } from 'express'
import { VERTICALS } from '../../constants/domain.constants'
import { Location, ServicedRoute } from '../../model/locationModel'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Where we actually go.
 *
 * The search box reads from here instead of a list compiled into the website,
 * so the office can open a new city and have it offered to customers without a
 * developer or a deploy (§15).
 */

const present = (l: any) => ({
   slug: l.slug,
   name: l.name,
   province: l.province,
   country: l.country,
   kind: l.kind,
   iata: l.iata,
   servesVerticals: l.servesVerticals,
   image: l.image,
})

/**
 * GET /locations?vertical=HOTEL
 *
 * Only active places, and only those that sell the requested product — a city
 * we run coaches to is not automatically somewhere we can book a hotel, and
 * offering it as one produces an empty results page that reads as "sold out".
 */
export const listLocations = catchAsync(async (req: Request, res: Response) => {
   const vertical = String(req.query.vertical || '').toUpperCase()
   const filter: Record<string, unknown> = { isActive: true }
   if (Object.values(VERTICALS).includes(vertical as never)) {
      filter.servesVerticals = vertical
   }
   const items = await Location.find(filter).sort({ sortOrder: 1, name: 1 }).limit(500)
   return sendResponse(res, 200, 'OK', { items: items.map(present) })
})

/**
 * GET /routes?vertical=FLIGHT[&origin=kinshasa]
 *
 * Flights and buses are sold as a pair, so the destination list depends on
 * where you are leaving from. Without `origin` this returns every serviced
 * pair, which is what the admin's route screen renders.
 */
export const listRoutes = catchAsync(async (req: Request, res: Response) => {
   const vertical = String(req.query.vertical || '').toUpperCase()
   if (vertical !== VERTICALS.FLIGHT && vertical !== VERTICALS.BUS) {
      return sendResponse(res, 200, 'OK', { items: [] })
   }

   const filter: Record<string, unknown> = { vertical, isActive: true }
   const originSlug = String(req.query.origin || '').trim()
   if (originSlug) {
      const origin = await Location.findOne({ slug: originSlug.toLowerCase(), isActive: true })
      // An unknown origin has no routes — not every route.
      if (!origin) return sendResponse(res, 200, 'OK', { items: [] })
      filter.origin = origin._id
   }

   const routes = await ServicedRoute.find(filter)
      .populate('origin destination')
      .limit(1000)

   const items = routes
      // A pair pointing at a deactivated city is not sellable.
      .filter((r: any) => r.origin?.isActive && r.destination?.isActive)
      .map((r: any) => ({
         vertical: r.vertical,
         origin: present(r.origin),
         destination: present(r.destination),
      }))

   return sendResponse(res, 200, 'OK', { items })
})
