import { Request, Response } from 'express'
import { getSettings } from '../../model/settingsModel'
import { getSiteContent, SITE_SECTION_NAMES } from '../../model/siteContentModel'
import { geoPoint } from '../../model/shared.schema'
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
 * windows that have no business on the open internet. Naming the fields
 * explicitly is what guarantees the rest can never leak, however Settings grows.
 *
 * `offices` is the list; the single-office fields predate it and are filled
 * from the primary office, so a client that only knows those keeps showing the
 * right address. With no offices entered they are blank, bar the support
 * phone and email from General.
 */
export const getSiteContact = catchAsync(async (_req: Request, res: Response) => {
   const s = await getSettings()
   const offices = (s.offices ?? []).map((o) => ({
      id: o._id.toString(),
      name: o.name,
      city: o.city,
      streetAddress: o.streetAddress ?? '',
      phone: o.phone ?? '',
      whatsapp: o.whatsapp ?? '',
      email: o.email ?? '',
      hours: o.hours ?? '',
      geo: geoPoint(o.geo),
      isPrimary: o.isPrimary === true,
   }))
   const primary = offices.find((o) => o.isPrimary) ?? offices[0]
   return sendResponse(res, 200, 'OK', {
      contact: {
         companyName: s.companyName ?? '',
         email: s.supportEmail ?? '',
         phone: primary?.phone || s.supportPhone || '',
         whatsapp: primary?.whatsapp ?? '',
         streetAddress: primary?.streetAddress ?? '',
         city: primary?.city ?? '',
         // Every office is in-country; the JSON-LD wants the ISO code.
         country: 'CD',
         officeHours: primary?.hours ?? '',
         offices,
      },
   })
})

/**
 * GET /api/v1/site/content            every section
 * GET /api/v1/site/content?section=footer   one of them
 *
 * The words and pictures the office edits from the panel: home banner, About,
 * Contact, Help and footer. Every language travels in one payload, as legal
 * texts do — the visitor switches language without another request.
 *
 * One section on its own exists for the footer: it is on every page, and a
 * visitor on a metered connection should not download the whole Help page to
 * read three lines.
 */
export const getSiteContentPublic = catchAsync(async (req: Request, res: Response) => {
   // `updatedAt` stays behind: when the office last edited is not the public's business.
   // eslint-disable-next-line @typescript-eslint/no-unused-vars
   const { updatedAt, ...content } = await getSiteContent()
   const only = SITE_SECTION_NAMES.find((name) => name === req.query.section)
   return sendResponse(res, 200, 'OK', {
      content: only ? { [only]: content[only] } : content,
   })
})
