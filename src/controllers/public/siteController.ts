import { Request, Response } from 'express'
import { getSettings } from '../../model/settingsModel'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * GET /api/v1/site/contact
 *
 * The office's own contact details, for the footer, the contact page and the
 * homepage structured data. They were hardcoded in three separate frontend
 * files, so moving office meant a developer and a deploy — §15 puts anything
 * the office changes behind the admin instead.
 *
 * A deliberately narrow slice of Settings: this is a public, unauthenticated
 * endpoint, and the same document holds hold TTLs, export caps and retention
 * windows that have no business on the open internet. Naming the six fields
 * explicitly is what guarantees the rest can never leak, however Settings grows.
 */
export const getSiteContact = catchAsync(async (_req: Request, res: Response) => {
   const s = await getSettings()
   return sendResponse(res, 200, 'OK', {
      contact: {
         companyName: s.companyName ?? '',
         email: s.supportEmail ?? '',
         phone: s.supportPhone ?? '',
         whatsapp: s.whatsappNumber ?? '',
         streetAddress: s.streetAddress ?? '',
         city: s.city ?? '',
         country: s.country ?? 'CD',
         officeHours: s.officeHours ?? '',
      },
   })
})
