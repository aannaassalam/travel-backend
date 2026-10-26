import { NextFunction, Request, Response } from 'express'
import { isValidObjectId } from 'mongoose'

import { IPartner, Partner } from '../../model/partnerModel'
import { createDoc, deleteDoc, updateDoc } from '../../services/adminCrud.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { isOwnPublicFile } from '../../utils/ownFile'
import { pick } from '../../utils/pick'
import { FieldMap, present, presentList } from '../../utils/present'
import { sendResponse } from '../../utils/response'

/**
 * Partners: a name, a logo and a website, shown as a row of logos on the
 * website's homepage and the app's Explore screen. Website content, not
 * inventory — edited under the content permissions.
 */

const ENTITY = 'Partner'
/** Where the logos are stored: the upload route pins it, the save checks it. */
const LOGO_FOLDER = 'partners'
const EDITABLE = ['name', 'logo', 'website', 'sortOrder', 'isActive'] as const

const partnerFields: FieldMap<IPartner> = {
   id: (p) => p._id.toString(),
   name: (p) => p.name,
   logo: (p) => p.logo,
   website: (p) => p.website,
   sortOrder: (p) => p.sortOrder,
   isActive: (p) => p.isActive,
   version: (p) => (p as any).__v,
   updatedAt: (p) => p.updatedAt,
}

/**
 * A page a visitor's browser can open: http or https, nothing else (`javascript:`, `tel:`…),
 * written out as the public list checks it: the parser alone also takes `https:/acme.cd`,
 * saved here and then dropped from the website without a word.
 */
const isWebAddress = (raw: string) => {
   try {
      return /^https?:\/\//i.test(raw) && ['http:', 'https:'].includes(new URL(raw).protocol)
   } catch {
      return false
   }
}

/** Each refusal says which box to fix. Only what the body carries is checked. */
export const checkPartner = (body: Record<string, any>) => {
   if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.replace(/\0/g, '').trim() : ''
      if (!name) throw new AppError('The partner name is required', 400)
      if (name.length > 120) throw new AppError('The partner name is limited to 120 characters', 400)
      body.name = name
   }
   // It goes into a page every visitor loads: only what the logo upload on
   // this screen hands back — our storage, this folder, a generated name — as
   // the website's own pictures are checked (see `isOwnPublicFile`).
   if (body.logo !== undefined && !isOwnPublicFile(body.logo, LOGO_FOLDER, '(\\.[a-z0-9]{1,5})?')) {
      throw new AppError('Logo: upload the picture from this screen', 400)
   }
   if (body.website !== undefined) {
      const website = body.website === null ? '' : typeof body.website === 'string' ? body.website.trim() : undefined
      if (website === undefined || website.length > 500 || (website && !isWebAddress(website))) {
         throw new AppError('Website: a full address starting with https:// (or http://), or blank', 400)
      }
      body.website = website
   }
   if (body.sortOrder !== undefined) {
      // A blank box is not 0 by accident: Number('') would be.
      const order = body.sortOrder === '' || body.sortOrder === null ? NaN : Number(body.sortOrder)
      if (!Number.isFinite(order)) throw new AppError('The order must be a number', 400)
      body.sortOrder = order
   }
   if (body.isActive !== undefined) body.isActive = Boolean(body.isActive)
}

/** GET /partners — the whole list, in the website's order: a few dozen, never thousands. */
export const listPartners = catchAsync(async (_req: Request, res: Response) => {
   const partners = await Partner.find()
      .collation({ locale: 'fr', strength: 1 })
      .sort({ sortOrder: 1, name: 1 })
      .limit(1000)
   return sendResponse(res, 200, 'OK', { items: presentList(partners, partnerFields) })
})

export const createPartner = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, EDITABLE)
   // Both are required; blank so the check names the missing one.
   body.name ??= ''
   body.logo ??= ''
   checkPartner(body)
   const partner = await createDoc<IPartner>(req, Partner, body, { entityType: ENTITY })
   return sendResponse(res, 201, 'Partner added', { partner: present(partner, partnerFields) })
})

export const updatePartner = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, EDITABLE)
   checkPartner(body)
   const partner = await updateDoc<IPartner>(req, Partner, req.params.id, body, {
      entityType: ENTITY,
   })
   return sendResponse(res, 200, 'Partner saved', { partner: present(partner, partnerFields) })
})

/** DELETE /partners/:id — nothing else points at a partner, so it can always go. */
export const deletePartner = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      if (!isValidObjectId(req.params.id)) return next(new AppError('Partner not found', 404))
      await deleteDoc(req, Partner, { _id: req.params.id }, { entityType: ENTITY })
      return sendResponse(res, 200, 'Partner deleted', {})
   }
)

/**
 * In front of the shared upload handler on POST /partners/logo: whoever may
 * edit partners may add a logo — public, in this folder and nowhere else —
 * without the inventory permission the general upload asks for.
 */
export const partnerLogosOnly = (req: Request, _res: Response, next: NextFunction) => {
   req.body = { ...req.body, folder: LOGO_FOLDER, visibility: 'public' }
   next()
}
