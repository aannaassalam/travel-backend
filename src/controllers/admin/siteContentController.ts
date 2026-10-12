import { NextFunction, Request, Response } from 'express'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import SiteContentModel, {
   getSiteContent,
   readSection,
   SITE_SECTION_NAMES,
   SITE_SECTIONS,
   SiteSection,
} from '../../model/siteContentModel'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * The website's own words, edited from the panel: home banner, About, Contact,
 * Help and footer. Legal texts are separate (`/policies`): those are versioned
 * and can never be edited in place.
 */

/** GET /site-content — every section as the site shows it now, and what each may hold. */
export const getContent = catchAsync(async (_req: Request, res: Response) => {
   const { updatedAt, ...content } = await getSiteContent()
   return sendResponse(res, 200, 'OK', { content, shape: SITE_SECTIONS, updatedAt })
})

/**
 * PUT /site-content/:section — replaces that one section.
 *
 * A section at a time, so saving the Help page cannot overwrite a colleague's
 * unsaved work on the footer, and the audit entry says which page changed.
 */
export const saveSection = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const section = String(req.params.section) as SiteSection
      if (!SITE_SECTION_NAMES.includes(section)) {
         return next(new AppError('Unknown section of the website', 404))
      }
      const value = readSection(section, req.body)
      const before = (await getSiteContent())[section]

      await SiteContentModel.findOneAndUpdate(
         {},
         { $set: { [section]: value } },
         { upsert: true, setDefaultsOnInsert: true }
      )
      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'SiteContent',
         entityId: section,
         before: { [section]: before },
         after: { [section]: value },
      })

      const { updatedAt, ...content } = await getSiteContent()
      return sendResponse(res, 200, 'Saved — the website shows it within a few minutes', {
         content,
         updatedAt,
      })
   }
)

/**
 * In front of the shared upload handler on POST /site-content/images: a
 * content editor may add pictures to the website's own folder and nowhere
 * else — not a private document, not another module's gallery.
 */
export const siteImagesOnly = (req: Request, _res: Response, next: NextFunction) => {
   req.body = { ...req.body, folder: 'site', visibility: 'public' }
   next()
}
