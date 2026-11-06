import {
   FULFILMENT_STATUS,
   ORDER_STATUS,
   PAYMENT_STATUS,
} from '../../constants/domain.constants'

/**
 * The office's workflow for a booking (2026-11-06), one step after another:
 * the payment is confirmed, then the documents are handed over, then the
 * booking is completed — or it is cancelled on the way. A delivered meal and a
 * ride have no papers to hand over: once paid they wait only for completion.
 *
 * Derived from the three status fields, so nothing new is stored.
 */
export const ORDER_STAGES = [
   'CASH_PENDING',
   'PAYMENT_PENDING',
   'CASH_PAID_PENDING_DOCUMENT',
   'PAID_PENDING_DOCUMENT',
   'DOCUMENT_DELIVERED_PENDING_COMPLETION',
   'PAID_PENDING_COMPLETION',
   'COMPLETED',
   'CANCELLED',
] as const
export type OrderStage = (typeof ORDER_STAGES)[number]

interface StagedOrder {
   status: string
   paymentStatus: string
   paymentMethod?: string
   fulfilmentStatus?: string
   delivery?: unknown
   items?: { vertical?: string }[]
}

/** Tickets, vouchers or vehicle papers to hand over: not a delivery, not a ride. */
export const needsDocuments = (o: StagedOrder) =>
   !o.delivery && !(o.items ?? []).some((i) => i.vertical === 'TRANSFER')

export const documentsDelivered = (o: StagedOrder) =>
   o.fulfilmentStatus === FULFILMENT_STATUS.DOCUMENTS_ISSUED ||
   o.fulfilmentStatus === FULFILMENT_STATUS.DELIVERED

export const orderStage = (o: StagedOrder): OrderStage => {
   if (o.status === ORDER_STATUS.CANCELLED) return 'CANCELLED'
   if (o.status === ORDER_STATUS.COMPLETED) return 'COMPLETED'
   const cash = o.paymentMethod === 'CASH'
   if (o.paymentStatus !== PAYMENT_STATUS.PAID) return cash ? 'CASH_PENDING' : 'PAYMENT_PENDING'
   if (!needsDocuments(o)) return 'PAID_PENDING_COMPLETION'
   if (documentsDelivered(o)) return 'DOCUMENT_DELIVERED_PENDING_COMPLETION'
   return cash ? 'CASH_PAID_PENDING_DOCUMENT' : 'PAID_PENDING_DOCUMENT'
}

// The same stages as database filters, for the queues and the dashboard.
const OPEN_PAID = {
   status: { $nin: [ORDER_STATUS.CANCELLED, ORDER_STATUS.COMPLETED] },
   paymentStatus: PAYMENT_STATUS.PAID,
}
// (as documentsDelivered: anything else, a missing value included, is "not yet")
const ISSUED = [FULFILMENT_STATUS.DOCUMENTS_ISSUED, FULFILMENT_STATUS.DELIVERED]

/** Paid, with tickets or vouchers still to hand over. */
export const pendingDocumentFilter = () => ({
   ...OPEN_PAID,
   fulfilmentStatus: { $nin: ISSUED },
   'delivery.address': { $exists: false },
   'items.vertical': { $ne: 'TRANSFER' },
})

/** Paid, documents handed over (or none to hand over): only completion left. */
export const pendingCompletionFilter = () => ({
   ...OPEN_PAID,
   $or: [
      { fulfilmentStatus: { $in: ISSUED } },
      { 'delivery.address': { $exists: true } },
      { 'items.vertical': 'TRANSFER' },
   ],
})
