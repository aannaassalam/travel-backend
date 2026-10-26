import { Request, Response } from 'express'

import { presentPublicPartners } from '../../dto/public/partner.dto'
import { Partner } from '../../model/partnerModel'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * GET /api/v1/partners — the logos for the "Our partners" section of the
 * website's homepage and the app's Explore screen: the active ones, in the
 * office's order, then by name. An empty list hides the section.
 */
export const listPartners = catchAsync(async (_req: Request, res: Response) => {
   const partners = await Partner.find({ isActive: true })
      .collation({ locale: 'fr', strength: 1 })
      .sort({ sortOrder: 1, name: 1 })
      .limit(200)
   return sendResponse(res, 200, 'OK', { items: presentPublicPartners(partners) })
})
