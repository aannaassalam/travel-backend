import { Request, Response, NextFunction } from 'express'
import { PolicyVersion } from '../../model/settingsModel'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Public read side of the admin's content section (§12, §15 — "making the owner
 * wait for a developer to change a policy text" is listed as a thing to avoid).
 *
 * The admin authors immutable `PolicyVersion` documents and flips `isLive`;
 * this is the only way the public site reads them. It is deliberately
 * read-only and deliberately separate from the admin controller (§14.3 rule 2).
 */

const KINDS = ['NO_REFUND', 'CANCELLATION', 'TERMS', 'PRIVACY'] as const
type Kind = (typeof KINDS)[number]

/**
 * Every live locale for one kind, in a single response.
 *
 * The site ships both languages in one static payload and picks per render,
 * exactly as it did when the text was a hardcoded `Record<Locale, …>`. Serving
 * one locale per request would mean either a second round trip on language
 * switch or a cache entry per locale, and the whole document is ~4 KB.
 */
export const getPolicy = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const kind = String(req.params.kind || '').toUpperCase() as Kind
      // Allow-list: the param reaches a query, and an unknown kind is a client
      // bug rather than an empty page.
      if (!KINDS.includes(kind)) {
         return next(new AppError('Unknown policy kind', 404))
      }

      const versions = await PolicyVersion.find({ kind, isLive: true })

      if (!versions.length) {
         return next(new AppError('No published version for this policy', 404))
      }

      // Newest wins if an operator ever manages to leave two live for a locale;
      // `setPolicyLive` prevents it, but the public page must still render.
      const byLocale: Record<string, string> = {}
      const sorted = [...versions].sort(
         (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      )
      for (const v of sorted) byLocale[v.locale] = v.body

      const newest = sorted[sorted.length - 1]

      return sendResponse(res, 200, 'OK', {
         policy: {
            kind,
            // Label and date come from the newest live version. They are shown
            // to the customer as "version X, in force since Y", so they must
            // describe text that is actually on the page.
            label: newest.label,
            effectiveFrom: newest.createdAt.toISOString().slice(0, 10),
            bodies: byLocale,
         },
      })
   }
)
