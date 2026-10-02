import { NextFunction, Request, Response } from 'express'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import {
   ALLOWED_ORDER_TRANSITIONS,
   CANCELLATION_REASONS,
   FULFILMENT_STATUS,
   ORDER_STATUS,
   PAYMENT_STATUS,
} from '../../constants/domain.constants'
import { presentOrder, presentOrderList } from '../../dto/admin/order.dto'
import { Customer } from '../../model/customerModel.admin'
import { RatePlan } from '../../model/hotelModel'
import { Listing } from '../../model/listingModel'
import { NOTIFICATION_EVENTS } from '../../model/enquiryModel'
import { notifyOrder } from '../../services/notifications/notify.service'
import { releaseListing, releaseStay } from '../../services/orders/inventory.service'
import { Order } from '../../model/orderModel'
import { paginate } from '../../services/adminCrud.service'
import { forReader } from '../../middleware/adminAuth'
import { recordAudit } from '../../services/auditLog.service'
import { storage } from '../../services/storage'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/** The changed order for someone who may read orders; its bare state otherwise. */
const orderFor = (req: Request, order: any) =>
   forReader(req, 'orders:read', () => presentOrder(order), {
      id: order._id.toString(),
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfilmentStatus: order.fulfilmentStatus,
   })

/** Free-text search box: NUL stripped (the driver throws on it) and capped so a pasted paragraph never becomes a regex. */
const searchTerm = (v: unknown) =>
   typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, 80) : ''
const searchRx = (value: string) =>
   new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

/**
 * §6.1: queues, not one list. Default landing is "Needs action" — the
 * administrator opens this to find what is on fire, not to browse an archive.
 */
const QUEUE_FILTERS: Record<string, () => Record<string, any>> = {
   'needs-action': () => ({
      $or: [
         // Paid but no documents issued.
         {
            paymentStatus: PAYMENT_STATUS.PAID,
            fulfilmentStatus: {
               $in: [FULFILMENT_STATUS.NOT_STARTED, FULFILMENT_STATUS.DOCUMENTS_PENDING],
            },
         },
         { paymentStatus: PAYMENT_STATUS.FAILED },
         { paymentStatus: PAYMENT_STATUS.REVERSED },
      ],
   }),
   'cash-pending': () => ({
      paymentMethod: 'CASH',
      paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING] },
      status: { $ne: ORDER_STATUS.CANCELLED },
   }),
   'awaiting-confirmation': () => ({ status: ORDER_STATUS.SUBMITTED }),
   'departing-soon': () => ({
      status: ORDER_STATUS.CONFIRMED,
      travelDate: {
         $gte: new Date(),
         $lte: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
   }),
   cancellations: () => ({ status: ORDER_STATUS.CANCELLED }),
   all: () => ({}),
}

export const listOrders = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const queue = String(req.query.queue || 'needs-action')
      const build = QUEUE_FILTERS[queue]
      if (!build) return next(new AppError(`Unknown queue: ${queue}`, 400))

      const filter: Record<string, any> = build()
      // §3: the reference read out over the phone is the primary lookup, but
      // the caller may equally give their name or number — so the customer
      // record is searched too and the order list is filtered to their ids.
      const q = searchTerm(req.query.q)
      if (q) {
         const rx = searchRx(q)
         const phones = [rx]
         // Local "0 81…" dialled form of a +243 E.164 phone.
         if (/^0\d+$/.test(q)) phones.push(searchRx('+243' + q.slice(1)))
         const customers = await Customer.find({
            $or: [
               ...phones.map((phone) => ({ phone })),
               { firstName: rx },
               { lastName: rx },
               { email: rx },
            ],
         })
            .select('_id')
            .limit(200)
         const search = {
            $or: [
               { reference: rx },
               { customer: { $in: customers.map((c) => c._id) } },
            ],
         }
         // The queue's own $or (needs-action) must stay in force as well.
         if (filter.$or) {
            filter.$and = [{ $or: filter.$or }, search]
            delete filter.$or
         } else {
            filter.$or = search.$or
         }
      }

      const sort =
         queue === 'cash-pending'
            ? ({ cashDeadline: 1 } as const) // §6.1: deadline ascending
            : ({ _id: -1 } as const)

      const { items, nextCursor } = await paginate(Order, filter, req, {
         sort: sort as any,
         populate: 'customer',
      })
      return sendResponse(res, 200, 'OK', {
         items: presentOrderList(items as any),
         nextCursor,
      })
   }
)

/** Counts for the queue tabs and the dashboard action panel. */
export const queueCounts = catchAsync(async (_req: Request, res: Response) => {
   const entries = await Promise.all(
      Object.entries(QUEUE_FILTERS)
         .filter(([k]) => k !== 'all')
         .map(async ([key, build]) => [key, await Order.countDocuments(build())])
   )
   return sendResponse(res, 200, 'OK', Object.fromEntries(entries))
})

export const getOrder = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      /**
       * documentNumber is select:false, so it must be asked for explicitly —
       * but §6.2 wants it MASKED here, not absent. Without it the UI renders
       * "—", which reads as "no passport on file" rather than "hidden".
       *
       * Safe because the DTO only ever emits `documentNumberMasked`; the raw
       * value has no allow-list entry and the leak tests assert that. Revealing
       * it is a separate step-up-gated, reason-required, logged endpoint below.
       */
      const order = await Order.findById(req.params.id)
         .select('+travellers.documentNumber')
         .populate('customer')
      if (!order) return next(new AppError('Order not found', 404))
      return sendResponse(res, 200, 'OK', { order: presentOrder(order) })
   }
)

const addTimeline = (order: any, req: Request, event: string, detail?: string, reason?: string) => {
   order.timeline.push({
      at: new Date(),
      event,
      detail,
      reason,
      actorEmail: (req as any).admin?.email,
   })
}

/**
 * §6.3: allow-listed transitions only, enforced server-side. Every manual
 * override requires a reason, stored and surfaced in the timeline and audit log.
 */
export const transitionOrder = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { to, reason } = req.body
      const order = await Order.findById(req.params.id)
      if (!order) return next(new AppError('Order not found', 404))

      const allowed = ALLOWED_ORDER_TRANSITIONS[order.status] || []
      if (!allowed.includes(to)) {
         return next(
            new AppError(
               `Cannot move an order from ${order.status} to ${to}`,
               400
            )
         )
      }
      if (!reason) {
         return next(new AppError('A reason is required for this change', 400))
      }

      const before = order.toObject()

      if (to === ORDER_STATUS.CONFIRMED) {
         /**
          * §6.3: confirming must verify inventory is still held. If the hold
          * expired, block rather than overselling — the customer would arrive
          * at a hotel with no room.
          */
         for (const item of order.items) {
            if (!item.roomTypeId || !item.startDate) continue
            const cells = await RatePlan.find({
               roomType: item.roomTypeId,
               date: { $gte: item.startDate, $lt: item.endDate || item.startDate },
            })
            const short = cells.find(
               (c) => c.allotment - c.sold < item.quantity
            )
            if (short) {
               return next(
                  new AppError(
                     `Inventory is no longer available for ${item.listingLabel} on ${short.date
                        .toISOString()
                        .slice(0, 10)}. Confirmation blocked to avoid overselling.`,
                     409
                  )
               )
            }
         }
         order.confirmedAt = new Date()
      }

      if (to === ORDER_STATUS.CANCELLED) {
         const code = req.body.cancellationReason
         if (!code || !(code in CANCELLATION_REASONS)) {
            return next(
               new AppError('A valid cancellation reason code is required', 400)
            )
         }
         order.cancellationReason = code
         order.cancelledAt = new Date()

         /**
          * §6.3: cancelling automatically releases inventory back to the lot.
          * Manual re-adding will be forgotten and the client will fail to sell
          * stock it still owns.
          */
         /**
          * What goes back depends on what the order was holding. A paid order
          * holds SOLD stock; an unpaid one only a HOLD. This used to subtract
          * from `sold` for hotel rooms whatever the order's state, and did
          * nothing at all for flights, buses, cars and activities — so
          * cancelling an unpaid booking took a night off the sold count it had
          * never added to, and left every other kind of seat held for ever.
          */
         const paid = order.paymentStatus === PAYMENT_STATUS.PAID
         const heldIds = order.heldRatePlanIds ?? []
         for (const item of order.items) {
            if (item.roomTypeId) {
               if (paid && item.startDate) {
                  await RatePlan.updateMany(
                     {
                        roomType: item.roomTypeId,
                        date: { $gte: item.startDate, $lt: item.endDate || item.startDate },
                        sold: { $gte: item.quantity },
                     },
                     { $inc: { sold: -item.quantity } }
                  )
               } else if (heldIds.length) {
                  await releaseStay(heldIds, item.quantity)
               }
            } else if (item.listingId) {
               if (paid) {
                  await Listing.updateOne(
                     { _id: item.listingId, quantitySold: { $gte: item.quantity } },
                     { $inc: { quantitySold: -item.quantity } }
                  )
               } else {
                  await releaseListing(item.listingId, item.quantity)
               }
            }
         }
         order.heldRatePlanIds = undefined
         addTimeline(order, req, 'INVENTORY_RELEASED', `${order.items.length} item(s)`)
      }

      if (to === ORDER_STATUS.COMPLETED) {
         // Completed means paid for and delivered; an unpaid one is neither.
         if (order.paymentStatus !== PAYMENT_STATUS.PAID) {
            return next(
               new AppError('An unpaid order cannot be completed', 409, 'ORDER_UNPAID')
            )
         }
         order.fulfilmentStatus = FULFILMENT_STATUS.DELIVERED
      }

      order.status = to
      addTimeline(order, req, `STATUS_${to}`, undefined, reason)
      await order.save()

      // The customer is told their booking is off; the office should never be
      // the only party that knows.
      if (to === ORDER_STATUS.CANCELLED) {
         void notifyOrder(NOTIFICATION_EVENTS.ORDER_CANCELLED, order._id)
      }
      if (to === ORDER_STATUS.CONFIRMED) {
         void notifyOrder(NOTIFICATION_EVENTS.ORDER_CONFIRMED, order._id)
      }

      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'Order',
         entityId: order._id.toString(),
         before,
         after: order.toObject(),
         reason,
      })

      return sendResponse(res, 200, `Order ${to.toLowerCase()}`, {
         order: orderFor(req, order),
      })
   }
)

const DOCUMENT_KINDS = ['ETICKET', 'VOUCHER', 'INVOICE']
/** Enough for a family's tickets in one go; the multer cap (10) sits above it. */
export const MAX_DOCUMENTS_PER_UPLOAD = 7

/**
 * Attach issued documents (e-tickets, vouchers, invoices) to an order.
 *
 * This is what DOCUMENTS_ISSUED had been missing: the Notifications screen
 * offered a template for the event, and nothing in the system could ever fire
 * it because there was no way to record that a document existed. The files
 * arrive with the request (multipart, field `files`, up to seven), are stored
 * privately (§6.5) and reached later through a signed link — only the key is
 * kept. One kind for the batch (`kind`), or one per file (`kinds`, a JSON list
 * in file order). The customer is told once, however many files came.
 */
export const attachDocument = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const files = ((req as any).files as Express.Multer.File[] | undefined) ?? []
      if (!files.length) return next(new AppError('Choose a file to attach', 400))
      if (files.length > MAX_DOCUMENTS_PER_UPLOAD) {
         return next(
            new AppError(`Attach up to ${MAX_DOCUMENTS_PER_UPLOAD} documents at a time`, 400)
         )
      }
      let kinds: unknown[]
      if (req.body?.kinds !== undefined) {
         try {
            kinds = JSON.parse(String(req.body.kinds))
         } catch {
            return next(new AppError('kinds must be a JSON list', 400))
         }
         if (!Array.isArray(kinds) || kinds.length !== files.length) {
            return next(new AppError('kinds must name one kind per file, in order', 400))
         }
      } else {
         kinds = files.map(() => req.body?.kind)
      }
      if (kinds.some((k) => !DOCUMENT_KINDS.includes(String(k)))) {
         return next(new AppError('kind must be ETICKET, VOUCHER or INVOICE', 400))
      }

      const order = await Order.findById(req.params.id)
      if (!order) return next(new AppError('Order not found', 404))
      if (order.status === ORDER_STATUS.CANCELLED) {
         return next(new AppError('A cancelled order cannot be issued documents', 409))
      }
      // Completed means handed over: the paperwork is closed with it.
      if (order.status === ORDER_STATUS.COMPLETED) {
         return next(new AppError('A completed order no longer takes documents', 409))
      }
      /**
       * A ticket or voucher is the thing being sold, so it is not handed over
       * before the money is recorded. An invoice is a request for payment and
       * may go out first.
       */
      if (kinds.some((k) => k !== 'INVOICE') && order.paymentStatus !== PAYMENT_STATUS.PAID) {
         return next(
            new AppError(
               'Record the payment before issuing a ticket or voucher',
               409,
               'ORDER_UNPAID'
            )
         )
      }
      const before = order.toObject()

      const issued: string[] = []
      for (const [i, file] of files.entries()) {
         const kind = String(kinds[i])
         /**
          * Stored here, in one step, rather than taking a storage key from the
          * request: a key in the body would let a caller attach ANY private
          * file they could name — another customer's ticket included. Always
          * private (§6.5): the customer reaches it through a short-lived
          * signed link.
          */
         const stored = await storage().save(
            {
               buffer: file.buffer,
               originalName: file.originalname,
               mimeType: file.mimetype,
               size: file.size,
            },
            { folder: `orders/${order.reference.toLowerCase()}`, visibility: 'private' }
         )
         // Re-issuing supersedes rather than replaces: a customer may already
         // hold the previous version, so support needs to see both.
         const previous = order.documents.filter((d: any) => d.kind === kind).length
         order.documents.push({
            kind,
            fileName: String(file.originalname).slice(0, 120),
            storageKey: stored.key,
            version: previous + 1,
            uploadedAt: new Date(),
            uploadedBy: (req as any).admin?.email,
         })
         issued.push(`${kind} v${previous + 1}`)
      }
      // Never step back from DELIVERED.
      if (order.fulfilmentStatus !== FULFILMENT_STATUS.DELIVERED) {
         order.fulfilmentStatus = FULFILMENT_STATUS.DOCUMENTS_ISSUED
      }
      addTimeline(order, req, 'DOCUMENTS_ISSUED', issued.join(', '))
      await order.save()

      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'Order',
         entityId: order._id.toString(),
         before,
         after: order.toObject(),
      })

      void notifyOrder(NOTIFICATION_EVENTS.DOCUMENTS_ISSUED, order._id)

      return sendResponse(
         res,
         200,
         files.length === 1 ? 'Document attached' : `${files.length} documents attached`,
         { order: orderFor(req, order) }
      )
   }
)

/**
 * Take a document back — the wrong file was sent, or the right one to the
 * wrong booking. Allowed until the order is completed; after that the
 * paperwork is closed. The customer's signed links expire within minutes and
 * the file itself is removed, so nothing keeps serving it.
 */
export const removeDocument = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const order = await Order.findById(req.params.id)
      if (!order) return next(new AppError('Order not found', 404))
      if (order.status === ORDER_STATUS.COMPLETED) {
         return next(new AppError('Documents on a completed order cannot be removed', 409))
      }
      const doc = (order.documents as any).id(req.params.documentId)
      if (!doc) return next(new AppError('Document not found', 404))
      const before = order.toObject()
      const { storageKey, kind, version, fileName } = doc

      ;(order.documents as any).pull(doc._id)
      // Nothing left to hand over: back to "paid, documents pending".
      if (!order.documents.length && order.fulfilmentStatus === FULFILMENT_STATUS.DOCUMENTS_ISSUED) {
         order.fulfilmentStatus = FULFILMENT_STATUS.DOCUMENTS_PENDING
      }
      addTimeline(order, req, 'DOCUMENT_REMOVED', `${kind} v${version} — ${fileName}`, req.body?.reason)
      await order.save()
      // The record is what matters; a file already gone is not an error.
      await storage()
         .remove(storageKey)
         .catch(() => undefined)

      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'Order',
         entityId: order._id.toString(),
         before,
         after: order.toObject(),
         reason: req.body?.reason,
      })

      return sendResponse(res, 200, 'Document removed', { order: orderFor(req, order) })
   }
)

export const markCashReceived = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const order = await Order.findById(req.params.id)
      if (!order) return next(new AppError('Order not found', 404))
      if (order.paymentMethod !== 'CASH') {
         return next(new AppError('This is not a cash order', 400))
      }
      /**
       * §BUG-001: idempotent, and only from the one state that means "owed at the
       * counter". Without this guard a second click double-fires the hold→sold
       * conversion, and a CANCELLED (inventory already released) order could be
       * revived straight to PAID.
       */
      if (
         order.status !== ORDER_STATUS.SUBMITTED ||
         order.paymentStatus !== PAYMENT_STATUS.UNPAID
      ) {
         return next(new AppError('Order is not awaiting cash payment', 409))
      }
      const before = order.toObject()

      /**
       * Convert the hold into a sale. Checkout holds stock; only payment sells
       * it. Marking a cash order paid without this leaves `quantityHeld`
       * incremented forever — the unit is neither on sale nor counted as sold,
       * so it silently disappears from the catalogue.
       */
      const heldIds = order.heldRatePlanIds ?? []
      for (const item of order.items) {
         if (item.roomTypeId && heldIds.length) {
            await RatePlan.updateMany(
               { _id: { $in: heldIds }, held: { $gte: item.quantity } },
               { $inc: { held: -item.quantity, sold: item.quantity } }
            )
         } else if (item.listingId) {
            await Listing.updateOne(
               { _id: item.listingId, quantityHeld: { $gte: item.quantity } },
               { $inc: { quantityHeld: -item.quantity, quantitySold: item.quantity } }
            )
         }
      }
      order.heldRatePlanIds = undefined

      order.status = ORDER_STATUS.CONFIRMED
      order.paymentStatus = PAYMENT_STATUS.PAID
      order.paidAt = new Date()
      order.cashDeadline = undefined
      order.fulfilmentStatus = FULFILMENT_STATUS.DOCUMENTS_PENDING
      addTimeline(order, req, 'CASH_RECEIVED', undefined, req.body.reason)
      await order.save()

      void notifyOrder(NOTIFICATION_EVENTS.PAYMENT_RECEIVED, order._id)

      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'Order',
         entityId: order._id.toString(),
         before,
         after: order.toObject(),
         reason: req.body.reason,
      })
      return sendResponse(res, 200, 'Cash recorded as received', {
         order: orderFor(req, order),
      })
   }
)

/**
 * §6.2 / §14.5: unmasking traveller document data is deliberate,
 * reason-required and logged — a sensitive READ that still writes to the audit
 * log even though nothing changed (§2.2).
 */
export const unmaskTravellerDocument = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { reason } = req.body
      if (!reason) {
         return next(
            new AppError('A typed reason is required to view document data', 400)
         )
      }
      const order = await Order.findById(req.params.id).select(
         '+travellers.documentNumber'
      )
      if (!order) return next(new AppError('Order not found', 404))

      const traveller = order.travellers.find(
         (t: any) => t._id.toString() === req.params.travellerId
      )
      if (!traveller) return next(new AppError('Traveller not found', 404))

      await recordAudit(req, {
         action: AUDIT_ACTIONS.PASSPORT_UNMASKED,
         entityType: 'Order',
         entityId: order._id.toString(),
         reason,
      })

      return sendResponse(res, 200, 'Document revealed', {
         documentNumber: traveller.documentNumber,
      })
   }
)

export const addInternalNote = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const order = await Order.findById(req.params.id)
      if (!order) return next(new AppError('Order not found', 404))
      // §6.2: internal notes are never customer-visible.
      order.internalNotes = req.body.note ?? order.internalNotes
      addTimeline(order, req, 'NOTE_ADDED', req.body.note)
      await order.save()
      return sendResponse(res, 200, 'Note saved', {
         order: orderFor(req, order),
      })
   }
)
