import { Request } from 'express'
import { Model } from 'mongoose'
import { AUDIT_ACTIONS } from '../constants/admin.constants'
import AppError from '../utils/appError'
import { recordAudit } from './auditLog.service'

/**
 * Shared write path for the admin surface.
 *
 * §2.2 requires every mutation to write an audit entry "enforced at the service
 * layer, not left to individual endpoints". That only holds if writes are hard
 * to perform any other way — so controllers call these instead of touching the
 * model directly, and the audit entry cannot be forgotten.
 */

export const MAX_PAGE_SIZE = 100

interface CrudOptions {
   entityType: string
   /** Reason is mandatory for some entities (§6.3 manual overrides). */
   requireReason?: boolean
}

export const createDoc = async <T>(
   req: Request,
   model: Model<any>,
   data: Record<string, any>,
   { entityType }: CrudOptions
): Promise<T> => {
   const doc = await model.create(data)
   await recordAudit(req, {
      action: AUDIT_ACTIONS.CREATE,
      entityType,
      entityId: doc._id.toString(),
      after: doc.toObject(),
   })
   return doc as T
}

/**
 * §2.2 optimistic concurrency: the client sends the `version` it read, and a
 * stale write gets a 409 instead of silently overwriting. Two browser tabs is a
 * routine collision even with one administrator.
 */
export const updateDoc = async <T>(
   req: Request,
   model: Model<any>,
   id: string,
   data: Record<string, any>,
   { entityType, requireReason }: CrudOptions
): Promise<T> => {
   const doc = await model.findById(id)
   if (!doc) throw new AppError(`${entityType} not found`, 404)

   const reason = req.body.reason
   if (requireReason && !reason) {
      throw new AppError('A reason is required for this change', 400)
   }

   const expected = req.body.version ?? req.get('if-match')
   if (expected !== undefined && Number(expected) !== doc.__v) {
      throw new AppError(
         'This record changed since you loaded it. Reload and reapply your edit.',
         409
      )
   }

   const before = doc.toObject()
   Object.entries(data).forEach(([k, v]) => {
      if (v !== undefined) (doc as any)[k] = v
   })
   await doc.save()

   await recordAudit(req, {
      action: AUDIT_ACTIONS.UPDATE,
      entityType,
      entityId: id,
      before,
      after: doc.toObject(),
      reason,
   })
   return doc as T
}

/**
 * §5.1 / §15: never hard delete. Archive instead — historical orders must
 * resolve to their listing forever. There is deliberately no deleteDoc here.
 */
export const archiveDoc = async <T>(
   req: Request,
   model: Model<any>,
   id: string,
   { entityType }: CrudOptions
): Promise<T> => {
   const doc = await model.findById(id)
   if (!doc) throw new AppError(`${entityType} not found`, 404)

   const before = doc.toObject()
   ;(doc as any).status = 'ARCHIVED'
   await doc.save()

   await recordAudit(req, {
      action: AUDIT_ACTIONS.DELETE,
      entityType,
      entityId: id,
      before,
      after: doc.toObject(),
      reason: req.body.reason,
   })
   return doc as T
}

/**
 * §2.2: cursor pagination, and no endpoint returns unbounded results. The cap
 * is applied here rather than trusted from the query string.
 */
export const paginate = async <T>(
   model: Model<any>,
   filter: Record<string, any>,
   req: Request,
   opts: { sort?: Record<string, 1 | -1>; populate?: string } = {}
): Promise<{ items: T[]; nextCursor: string | null }> => {
   const limit = Math.min(Number(req.query.limit) || 25, MAX_PAGE_SIZE)
   const cursor = req.query.cursor as string | undefined
   const query = { ...filter }
   if (cursor) query._id = { $lt: cursor }

   let q = model
      .find(query)
      .sort(opts.sort || { _id: -1 })
      .limit(limit + 1)
   if (opts.populate) q = q.populate(opts.populate)

   const docs = await q
   const hasMore = docs.length > limit
   const page = hasMore ? docs.slice(0, limit) : docs

   return {
      items: page as T[],
      nextCursor: hasMore ? page[page.length - 1]._id.toString() : null,
   }
}
