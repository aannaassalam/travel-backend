import { NextFunction, Request, Response } from 'express'
import { isValidObjectId, Types } from 'mongoose'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { VERTICALS } from '../../constants/domain.constants'
import { Hotel } from '../../model/hotelModel'
import { Listing } from '../../model/listingModel'
import { ISupplier, Supplier } from '../../model/supplierModel'
import { createDoc, deleteDoc, updateDoc } from '../../services/adminCrud.service'
import { recordAudit } from '../../services/auditLog.service'
import { storage } from '../../services/storage'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { pick } from '../../utils/pick'
import { FieldMap, present, presentList } from '../../utils/present'
import { sendResponse } from '../../utils/response'

/**
 * Suppliers: recorded once, picked from a list on every hotel and listing, so
 * whoever is on duty can reach the hotel, the agency or the car hire firm from
 * a booking. For a bus or flight route the supplier is its travel agency.
 */

const ENTITY = 'Supplier'
const EDITABLE = ['name', 'phone', 'email', 'contactName', 'address', 'notes', 'isActive'] as const
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export const supplierFields: FieldMap<ISupplier> = {
   id: (s) => s._id.toString(),
   name: (s) => s.name,
   phone: (s) => s.phone,
   email: (s) => s.email,
   contactName: (s) => s.contactName,
   address: (s) => s.address,
   notes: (s) => s.notes,
   isActive: (s) => s.isActive,
   // No storage key: a file is opened through GET …/documents/:documentId/link.
   documents: (s) =>
      (s.documents ?? []).map((d) => ({
         id: d._id.toString(),
         fileName: d.fileName,
         size: d.size,
         mimeType: d.mimeType,
         uploadedAt: d.uploadedAt,
         uploadedBy: d.uploadedBy,
      })),
   version: (s) => (s as any).__v,
   updatedAt: (s) => s.updatedAt,
}

const escapeRx = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The same name in any case is the same supplier: two "Transco" would split its bookings. */
const checkBody = async (body: any, except?: string) => {
   if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) throw new AppError('The supplier name is required', 400)
      const taken = await Supplier.exists({
         name: new RegExp(`^${escapeRx(name)}$`, 'i'),
         ...(except ? { _id: { $ne: except } } : {}),
      })
      if (taken) throw new AppError(`A supplier called ${name} already exists`, 409, 'SUPPLIER_EXISTS')
      body.name = name
   }
   for (const key of ['phone', 'email', 'contactName', 'address', 'notes'] as const) {
      if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') {
         throw new AppError(`${key} must be text`, 400)
      }
   }
   const email = String(body.email ?? '').trim()
   if (email && !EMAIL_RX.test(email)) throw new AppError('That email address is not valid', 400)
   if (body.isActive !== undefined) body.isActive = Boolean(body.isActive)
}

/** How many hotels and listings name each supplier — archived ones too: they still do. */
const usage = async (ids: Types.ObjectId[]) => {
   const count = (model: any) =>
      model.aggregate([
         { $match: { supplier: { $in: ids } } },
         { $group: { _id: '$supplier', n: { $sum: 1 } } },
      ])
   const [hotels, listings] = await Promise.all([count(Hotel), count(Listing)])
   const out = new Map<string, { hotels: number; listings: number }>()
   for (const id of ids) out.set(String(id), { hotels: 0, listings: 0 })
   for (const r of hotels) out.get(String(r._id))!.hotels = r.n
   for (const r of listings) out.get(String(r._id))!.listings = r.n
   return out
}

/** GET /suppliers?q=&active= — the whole list: a few dozen, never thousands. */
export const listSuppliers = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, any> = {}
   const q = typeof req.query.q === 'string' ? req.query.q.replace(/\0/g, '').trim().slice(0, 80) : ''
   if (q) {
      const rx = new RegExp(escapeRx(q), 'i')
      filter.$or = [{ name: rx }, { contactName: rx }, { phone: rx }, { email: rx }]
   }
   if (req.query.active === 'true') filter.isActive = true
   const suppliers = await Supplier.find(filter)
      .collation({ locale: 'fr', strength: 1 })
      .sort({ name: 1 })
      .limit(1000)
   const used = await usage(suppliers.map((s) => s._id))
   return sendResponse(res, 200, 'OK', {
      items: suppliers.map((s) => ({ ...present(s, supplierFields), usedBy: used.get(String(s._id)) })),
   })
})

export const createSupplier = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, EDITABLE)
   if (body.name === undefined) body.name = ''
   await checkBody(body)
   const supplier = await createDoc<ISupplier>(req, Supplier, body, { entityType: ENTITY })
   return sendResponse(res, 201, 'Supplier created', { supplier: present(supplier, supplierFields) })
})

export const updateSupplier = catchAsync(async (req: Request, res: Response) => {
   const body = pick(req.body, EDITABLE)
   await checkBody(body, req.params.id)
   const supplier = await updateDoc<ISupplier>(req, Supplier, req.params.id, body, {
      entityType: ENTITY,
   })
   // A route or a car shows its supplier's name as the operator: a rename shows there too.
   if (body.name !== undefined) await syncOperatorName(supplier._id, supplier.name)
   return sendResponse(res, 200, 'Supplier saved', { supplier: present(supplier, supplierFields) })
})

/** DELETE /suppliers/:id — only one nothing names. Otherwise it is switched off. */
export const deleteSupplier = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      if (!isValidObjectId(req.params.id)) return next(new AppError('Supplier not found', 404))
      const id = new Types.ObjectId(req.params.id)
      const { hotels, listings } = (await usage([id])).get(String(id))!
      if (hotels || listings) {
         return next(
            new AppError(
               `This supplier is named on ${hotels} hotel(s) and ${listings} listing(s). Switch it off instead, or choose another supplier on those first.`,
               409,
               'SUPPLIER_IN_USE'
            )
         )
      }
      const gone = await deleteDoc<any>(req, Supplier, { _id: id }, { entityType: ENTITY })
      // Its files go with it, once the record (and its audit copy) is settled.
      await removeFiles(gone.documents ?? [])
      return sendResponse(res, 200, 'Supplier deleted', {})
   }
)

// --- Documents: contracts, licences, IDs — private, opened by a signed link ---

/** As long as the signed-link window elsewhere (§14.4). */
const DOCUMENT_LINK_SECONDS = 15 * 60

/** The record is what matters; a file already gone is not an error. */
const removeFiles = (docs: { storageKey?: string }[]) =>
   Promise.all(
      docs.map((d) => (d.storageKey ? storage().remove(d.storageKey).catch(() => undefined) : undefined))
   )

const findSupplier = async (id: string) =>
   isValidObjectId(id) ? Supplier.findById(id) : null

/**
 * POST /suppliers/:id/documents — multipart, field `files`, up to ten (the
 * upload middleware's cap): PDF or pictures. Stored here, never from a key in
 * the body — that would let a caller attach any private file they could name.
 */
export const attachDocuments = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const files = ((req as any).files as Express.Multer.File[] | undefined) ?? []
      if (!files.length) return next(new AppError('Choose a file to upload', 400))
      const supplier = await findSupplier(req.params.id)
      if (!supplier) return next(new AppError('Supplier not found', 404))
      const before = supplier.toObject()

      // Removed again if the record never names them (a 409 meanwhile, a bad file).
      const saved: { storageKey: string }[] = []
      try {
         for (const file of files) {
            const stored = await storage().save(
               { buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype, size: file.size },
               { folder: `suppliers/${supplier._id}`, visibility: 'private' }
            )
            saved.push({ storageKey: stored.key })
            supplier.documents.push({
               fileName: String(file.originalname).slice(0, 120),
               storageKey: stored.key,
               mimeType: file.mimetype,
               size: file.size,
               uploadedAt: new Date(),
               uploadedBy: (req as any).admin?.email,
            })
         }
         await supplier.save()
      } catch (err) {
         await removeFiles(saved)
         throw err
      }
      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: ENTITY,
         entityId: supplier._id.toString(),
         before,
         after: supplier.toObject(),
         reason: `Documents added: ${files.map((f) => f.originalname).join(', ')}`.slice(0, 500),
      })
      return sendResponse(
         res,
         200,
         files.length === 1 ? 'Document uploaded' : `${files.length} documents uploaded`,
         { supplier: present(supplier, supplierFields) }
      )
   }
)

/** DELETE /suppliers/:id/documents/:documentId — the entry, then the stored file. */
export const removeDocument = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const supplier = await findSupplier(req.params.id)
      if (!supplier) return next(new AppError('Supplier not found', 404))
      const doc = supplier.documents.id(req.params.documentId)
      if (!doc) return next(new AppError('Document not found', 404))
      const before = supplier.toObject()
      const { storageKey, fileName } = doc

      supplier.documents.pull(doc._id)
      await supplier.save()
      await removeFiles([{ storageKey }])
      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: ENTITY,
         entityId: supplier._id.toString(),
         before,
         after: supplier.toObject(),
         reason: `Document removed: ${fileName}`,
      })
      return sendResponse(res, 200, 'Document removed', { supplier: present(supplier, supplierFields) })
   }
)

/**
 * GET /suppliers/:id/documents/:documentId/link — a link to that one file,
 * good for 15 minutes and saved under its own name. Only a key this supplier
 * holds is ever signed.
 */
export const documentLink = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const supplier = await findSupplier(req.params.id)
      const doc = supplier?.documents.id(req.params.documentId)
      if (!supplier || !doc) return next(new AppError('Document not found', 404))

      const link = await storage().signedUrl(doc.storageKey, DOCUMENT_LINK_SECONDS, doc.fileName)
      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: ENTITY,
         entityId: supplier._id.toString(),
         reason: `signed download link issued: ${doc.fileName}`,
      })
      // The local driver answers with a path on this API; S3 with a full URL.
      const base = (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
      return sendResponse(res, 200, 'Link generated', {
         url: /^https?:\/\//.test(link) ? link : `${base}${link}`,
         fileName: doc.fileName,
         expiresInSeconds: DOCUMENT_LINK_SECONDS,
      })
   }
)

/**
 * The operator name a bus or flight route shows is its agency's name, and a
 * car's is its rental company's: kept in step.
 */
export const syncOperatorName = (supplierId: Types.ObjectId, name: string) =>
   Listing.updateMany(
      {
         supplier: supplierId,
         vertical: { $in: [VERTICALS.BUS, VERTICALS.FLIGHT, VERTICALS.CAR] },
         'attributes.operator': { $ne: name },
      },
      { $set: { 'attributes.operator': name }, $inc: { __v: 1 } }
   )

/**
 * A supplier as a hotel or listing names it: an id from the list, or blank to
 * clear it. Anything else is refused — free text here is what this list
 * replaced. Returns `undefined` when the body did not mention it.
 */
export const supplierRef = async (raw: unknown): Promise<Types.ObjectId | null | undefined> => {
   if (raw === undefined) return undefined
   if (raw === null || raw === '') return null
   const supplier = isValidObjectId(raw) ? await Supplier.findById(raw).select('_id') : null
   if (!supplier) throw new AppError('Choose a supplier from the list (Suppliers)', 400, 'UNKNOWN_SUPPLIER')
   return supplier._id
}

export const presentSuppliers = (s: ISupplier[]) => presentList(s, supplierFields)
