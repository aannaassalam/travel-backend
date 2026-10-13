import { Request } from 'express'
import { Model } from 'mongoose'
import { AUDIT_ACTIONS } from '../constants/admin.constants'
import { LISTING_STATUS, ORDER_STATUS } from '../constants/domain.constants'
import { Order } from '../model/orderModel'
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
 * Archive: the record leaves the lists and the website and stays in the
 * database. Still the everyday way to retire something.
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
      /** A value worked out per row to order by (see `sortBy`); `sort` then names it. */
      computed?: ComputedSort
   } = {}
): Promise<Page<T>> => {
   const limit = whole(req.query.limit, 25, MAX_PAGE_SIZE)
   // "Everything before this id" is only a place in the list when the list is
   // in id order; a sorted list is paged by number.
   const cursor = opts.sort ? undefined : (req.query.cursor as string | undefined)
   const page = cursor ? 1 : whole(req.query.page, 1, MAX_PAGE)
   const query = { ...filter }
   if (cursor) query._id = { $lt: cursor }

   // ponytail: skip() walks the rows it skips. Fine for a back office paging
   // through thousands; move the deep pages to a range query if a list ever
   // reaches the hundreds of thousands.
   let q: any
   if (opts.computed) {
      // A margin, a number of delivery zones, a customer's name on an order:
      // nothing stored orders these, so the page is picked by an aggregation
      // that works the value out — ids only — and the rows are then read the
      // ordinary way, so every list still hands the same documents to its DTO.
      const pipeline: any[] = [
         // aggregate() does not cast a filter to the schema; find() does.
         { $match: model.find(filter).cast(model) },
         ...(opts.computed.lookup ? [{ $lookup: opts.computed.lookup }] : []),
         { $addFields: { [COMPUTED_SORT]: opts.computed.value } },
         { $sort: opts.sort },
         { $skip: (page - 1) * limit },
         { $limit: limit + 1 },
         { $project: { _id: 1 } },
      ]
      let picked = model.aggregate(pipeline)
      if (opts.collation) picked = picked.collation(opts.collation)
      const ids = (await picked).map((d: any) => d._id)
      const place = new Map(ids.map((id: any, i: number) => [String(id), i]))
      let rows = model.find({ _id: { $in: ids } })
      if (opts.populate) rows = rows.populate(opts.populate)
      q = rows.then((found: any[]) =>
         found.sort((a, b) => place.get(String(a._id))! - place.get(String(b._id))!)
      )
   } else {
      q = model
         .find(query)
         .sort(opts.sort || { _id: -1 })
         .skip((page - 1) * limit)
         .limit(limit + 1)
      if (opts.collation) q = q.collation(opts.collation)
      if (opts.populate) q = q.populate(opts.populate)
   }

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
      nextCursor: hasMore && !opts.sort ? items[items.length - 1]._id.toString() : null,
   }
}

/** The name the worked-out value travels under inside the aggregation. */
const COMPUTED_SORT = '__sortValue'

/** A value worked out per row to order a list by, when nothing stored does. */
export interface ComputedSort {
   /** An aggregation expression, in terms of the document ("$field"). */
   value: any
   /** Another collection to join first, when the value lives on a linked record. */
   lookup?: { from: string; localField: string; foreignField: string; as: string }
}

/**
 * What one sortable column orders by: a stored path, several stored paths in
 * turn (first name, then last name), or a value worked out per row.
 */
export type SortKey = string | string[] | ComputedSort

/**
 * `?sort=name` (first to last) or `?sort=-name` (last to first), for the
 * columns a list allows — every column its table shows. Anything else keeps
 * the list's own order. French collation at strength 1, so "École" files under
 * E and case is ignored.
 */
export const sortBy = (raw: unknown, fields: Record<string, SortKey>) => {
   const key = typeof raw === 'string' ? raw : ''
   const descending = key.startsWith('-')
   const name = descending ? key.slice(1) : key
   // Own keys only: `?sort=constructor` must not find Object's.
   if (!Object.hasOwn(fields, name)) return {}
   const by = fields[name]
   const direction = descending ? -1 : 1
   const computed = typeof by === 'string' || Array.isArray(by) ? undefined : by
   const paths = computed ? [COMPUTED_SORT] : typeof by === 'string' ? [by] : (by as string[])
   // ponytail: no index carries this collation, so a sorted list is matched and
   // ordered without one. Right for a catalogue of thousands; give name.fr and
   // title.fr a collated index if one ever reaches the hundreds of thousands.
   return {
      sort: {
         ...Object.fromEntries(paths.map((path) => [path, direction])),
         // _id settles ties, so a row never appears on two pages.
         _id: 1,
      } as Record<string, 1 | -1>,
      collation: { locale: 'fr', strength: 1 },
      computed,
   }
}

/**
 * Orders a column of codes by the words the panel shows for them (see
 * PANEL_WORDS); a code it has no words for by its own, spelled out.
 */
export const byWords = (field: string, words: Record<string, string>): ComputedSort => ({
   value: {
      $switch: {
         branches: Object.entries(words).map(([code, shown]) => ({
            case: { $eq: [`$${field}`, code] },
            then: shown,
         })),
         default: {
            $replaceAll: {
               input: { $toLower: { $ifNull: [`$${field}`, ''] } },
               find: '_',
               replacement: ' ',
            },
         },
      },
   },
})

/** How many of the languages a record is fully translated into (name and description both), as the lists' Translations column counts it. */
export const translatedCount = (name: string, locales: readonly string[]) => ({
   $sum: locales.map((l) => ({
      $cond: [
         {
            $and: [
               { $gt: [{ $strLenCP: { $convert: { input: `$${name}.${l}`, to: 'string', onError: '', onNull: '' } } }, 0] },
               { $gt: [{ $strLenCP: { $convert: { input: `$description.${l}`, to: 'string', onError: '', onNull: '' } } }, 0] },
            ],
         },
         1,
         0,
      ],
   })),
})

/** A linked customer's name ("first last"), for ordering orders and payments by it. */
export const customerNameSort: ComputedSort = {
   lookup: { from: 'platform_customers', localField: 'customer', foreignField: '_id', as: '__customer' },
   value: {
      $concat: [
         { $ifNull: [{ $first: '$__customer.firstName' }, ''] },
         ' ',
         { $ifNull: [{ $first: '$__customer.lastName' }, ''] },
      ],
   },
}

/**
 * Removes a record for good — the owner's call: an admin has to be able to
 * clear out what was created by mistake, not only hide it.
 *
 * What makes that safe to offer is spread over three places. The route: a
 * delete permission of its own, and the admin's password re-entered minutes
 * ago. The controller: nothing is left pointing at what goes (orders hold
 * their own copy of what they sold; what cannot stand alone goes with it).
 * And here: the audit log keeps the record as it was, so it can be read back.
 */
export const deleteDoc = async <T>(
   req: Request,
   model: Model<any>,
   filter: Record<string, any>,
   {
      entityType,
      snapshot,
      reason,
      withIt,
   }: CrudOptions & {
      /** What the audit log keeps, when that should not be the whole record (personal data). */
      snapshot?: (doc: any) => unknown
      reason?: string
      /** Removes what cannot stand without the record (a hotel's rooms, a restaurant's menu), just before it. */
      withIt?: () => Promise<unknown>
   }
): Promise<T> => {
   const doc = await model.findOne(filter)
   if (!doc) throw new AppError(`${entityType} not found`, 404)
   const before = doc.toObject()
   // The entry first. Stopped half way, the log then says what was being
   // removed and holds its copy, and the delete can be asked for again; the
   // other way round a record — or its rooms and prices — could go and leave
   // no trace of who removed it.
   await recordAudit(req, {
      action: AUDIT_ACTIONS.PURGE,
      entityType,
      entityId: String(doc._id),
      before: snapshot ? snapshot(before) : before,
      reason,
   })
   await withIt?.()
   await doc.deleteOne()
   return before as T
}

/**
 * Bookings still in progress that name a record about to be deleted. They are
 * not harmed — an order line is a copy of what was sold — but the admin should
 * know before the item behind them goes: the first attempt is refused with
 * the count, and `?confirm=1` goes ahead.
 */
export const confirmOverOpenBookings = async (
   req: Request,
   match: Record<string, any>,
   what: string
) => {
   if (req.query.confirm === '1') return
   const open = await Order.countDocuments({
      status: { $in: [ORDER_STATUS.DRAFT, ORDER_STATUS.SUBMITTED, ORDER_STATUS.CONFIRMED] },
      ...match,
   })
   if (!open) return
   throw new AppError(
      `${open} booking${open === 1 ? '' : 's'} in progress ${open === 1 ? 'is' : 'are'} for ${what}. ${open === 1 ? 'It keeps its' : 'They keep their'} own copy of the details and will not change. Delete it anyway?`,
      409,
      'OPEN_BOOKINGS'
   )
}
