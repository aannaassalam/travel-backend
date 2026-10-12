import { Request } from 'express'
import { Model } from 'mongoose'
import { AUDIT_ACTIONS } from '../constants/admin.constants'
import { LISTING_STATUS } from '../constants/domain.constants'
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
 * Take a record off the website without archiving it. Publishing brings it
 * back, and unlike an archived record it stays in the admin lists — one click
 * from live again. Whatever it was (published, sold out, expired) it ends up
 * INACTIVE. Nothing else on it changes, bar what `also` names — a schedule
 * that would put it straight back on sale, say.
 */
export const deactivateDoc = async <T>(
   req: Request,
   model: Model<any>,
   id: string,
   { entityType }: CrudOptions,
   also: Record<string, unknown> = {}
): Promise<T> => {
   const doc = await model.findById(id)
   if (!doc) throw new AppError(`${entityType} not found`, 404)
   if ((doc as any).status === LISTING_STATUS.ARCHIVED) {
      // Archived is a separate decision; deactivating must not quietly undo it.
      throw new AppError('This record is archived, so there is nothing to deactivate', 409)
   }

   const before = doc.toObject()
   ;(doc as any).status = LISTING_STATUS.INACTIVE
   Object.entries(also).forEach(([k, v]) => ((doc as any)[k] = v))
   await doc.save()

   await recordAudit(req, {
      action: AUDIT_ACTIONS.UPDATE,
      entityType,
      entityId: id,
      before,
      after: doc.toObject(),
      reason: req.body?.reason ?? 'Deactivated',
   })
   return doc as T
}

/**
 * §2.2: no endpoint returns unbounded results. The cap is applied here rather
 * than trusted from the query string.
 *
 * Numbered pages (`?page=2`) are what the panel's lists use: they need a total
 * to draw "page 2 of 6", and an order other than newest-first. A `cursor` is
 * still honoured for the callers that scroll instead (the enquiries board).
 */
export interface Page<T> {
   items: T[]
   /** Everything the filter matches, not just this page. */
   total: number
   page: number
   pageSize: number
   pages: number
   nextCursor: string | null
}

/** A whole number between 1 and `max`; anything else (text, 0, 1e400) is `fallback` or the nearest bound. */
const whole = (raw: unknown, fallback: number, max: number) =>
   Math.min(Math.max(Math.floor(Number(raw)) || fallback, 1), max)

// Far past any list here, and keeps `skip` a number the driver accepts.
const MAX_PAGE = 100_000

export const paginate = async <T>(
   model: Model<any>,
   filter: Record<string, any>,
   req: Request,
   opts: {
      sort?: Record<string, 1 | -1>
      populate?: string
      /** For sorting text the way a person would: accents and case ignored. */
      collation?: { locale: string; strength?: number }
   } = {}
): Promise<Page<T>> => {
   const limit = whole(req.query.limit, 25, MAX_PAGE_SIZE)
   const cursor = req.query.cursor as string | undefined
   const page = cursor ? 1 : whole(req.query.page, 1, MAX_PAGE)
   const query = { ...filter }
   if (cursor) query._id = { $lt: cursor }

   // ponytail: skip() walks the rows it skips. Fine for a back office paging
   // through thousands; move the deep pages to a range query if a list ever
   // reaches the hundreds of thousands.
   let q = model
      .find(query)
      .sort(opts.sort || { _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit + 1)
   if (opts.collation) q = q.collation(opts.collation)
   if (opts.populate) q = q.populate(opts.populate)

   // Counted under the same collation as the rows are read: it also decides
   // how text in the filter compares, and a total reached by other rules is
   // how a page shows six rows under "0 results".
   let count = model.countDocuments(filter)
   if (opts.collation) count = count.collation(opts.collation)
   const [docs, total] = await Promise.all([q, count])
   const hasMore = docs.length > limit
   const items = hasMore ? docs.slice(0, limit) : docs

   return {
      items: items as T[],
      total,
      page,
      pageSize: limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      nextCursor: hasMore ? items[items.length - 1]._id.toString() : null,
   }
}

/**
 * `?sort=name` (A to Z) or `?sort=-name` (Z to A), for the columns a list
 * allows. Anything else keeps the list's own order. French collation at
 * strength 1, so "École" files under E and case is ignored.
 */
export const sortBy = (raw: unknown, fields: Record<string, string>) => {
   const key = typeof raw === 'string' ? raw : ''
   const descending = key.startsWith('-')
   const name = descending ? key.slice(1) : key
   // Own keys only: `?sort=constructor` must not find Object's.
   if (!Object.hasOwn(fields, name)) return {}
   const path = fields[name]
   // ponytail: no index carries this collation, so a sorted list is matched and
   // ordered without one. Right for a catalogue of thousands; give name.fr and
   // title.fr a collated index if one ever reaches the hundreds of thousands.
   return {
      // _id settles ties, so a row never appears on two pages.
      sort: { [path]: descending ? -1 : 1, _id: 1 } as Record<string, 1 | -1>,
      collation: { locale: 'fr', strength: 1 },
   }
}
