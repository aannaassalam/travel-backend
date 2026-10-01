import { ICustomer } from '../../model/customerModel.admin'
import { IOrder } from '../../model/orderModel'
import { lineCost } from '../../utils/orderMath'
import {
   FieldMap,
   maskDocumentNumber,
   maskPhone,
   present,
   presentList,
} from '../../utils/present'

/**
 * §8: phone numbers masked by default in LIST views, revealed on the detail
 * screen. A screenshot of a customer list should not be a customer database.
 */
const customerListFields: FieldMap<ICustomer> = {
   id: (c) => c._id.toString(),
   fullName: (c) => [c.firstName, c.lastName].filter(Boolean).join(' '),
   phoneMasked: (c) => maskPhone(c.phone),
   city: (c) => c.city,
   isBlocked: (c) => c.isBlocked,
   noShowCount: (c) => c.noShowCount,
   createdAt: (c) => c.createdAt,
}

export const presentCustomerList = (c: ICustomer[]) =>
   presentList(c, customerListFields)

/** Detail view — full phone, still no internal-only surprises. */
const customerDetailFields: FieldMap<ICustomer> = {
   ...customerListFields,
   phone: (c) => c.phone,
   email: (c) => c.email,
   firstName: (c) => c.firstName,
   lastName: (c) => c.lastName,
   locale: (c) => c.locale,
   internalNotes: (c) => c.internalNotes,
   version: (c) => (c as any).__v,
}

export const presentCustomer = (c: ICustomer) =>
   present(c, customerDetailFields)

// ---------------------------------------------------------------------------

const orderListFields: FieldMap<IOrder> = {
   id: (o) => o._id.toString(),
   reference: (o) => o.reference,
   status: (o) => o.status,
   paymentStatus: (o) => o.paymentStatus,
   fulfilmentStatus: (o) => o.fulfilmentStatus,
   total: (o) => o.total,
   currency: (o) => o.currency,
   chargedTotal: (o) => o.chargedTotal,
   chargedCurrency: (o) => o.chargedCurrency,
   paymentMethod: (o) => o.paymentMethod,
   cashDeadline: (o) => o.cashDeadline,
   travelDate: (o) => o.travelDate,
   customer: (o: any) =>
      o.customer && typeof o.customer === 'object'
         ? {
              id: o.customer._id?.toString(),
              fullName: [o.customer.firstName, o.customer.lastName]
                 .filter(Boolean)
                 .join(' '),
              phoneMasked: maskPhone(o.customer.phone),
           }
         : undefined,
   createdAt: (o) => o.createdAt,
}

export const presentOrderList = (o: IOrder[]) => presentList(o, orderListFields)

/**
 * §6.2 order detail. Traveller document numbers are masked here; unmasking is a
 * separate, reason-required, logged endpoint (§14.5).
 */
const orderDetailFields: FieldMap<IOrder> = {
   ...orderListFields,
   customer: (o: any) =>
      o.customer && typeof o.customer === 'object'
         ? {
              id: o.customer._id?.toString(),
              fullName: [o.customer.firstName, o.customer.lastName]
                 .filter(Boolean)
                 .join(' '),
              phone: o.customer.phone,
              email: o.customer.email,
           }
         : undefined,
   channel: (o) => o.channel,
   fxRate: (o) => o.fxRate,
   items: (o) =>
      o.items?.map((i: any) => ({
         id: i._id?.toString(),
         vertical: i.vertical,
         listingId: i.listingId?.toString(),
         listingLabel: i.listingLabel,
         startDate: i.startDate,
         endDate: i.endDate,
         quantity: i.quantity,
         unitSellPrice: i.unitSellPrice,
         // Admin surface only — §2.1's exact example of what must never leak.
         unitCostPrice: i.unitCostPrice,
         margin: i.lineTotal - lineCost(i),
         lineTotal: i.lineTotal
      })),
   travellers: (o) =>
      o.travellers?.map((t: any) => ({
         id: t._id?.toString(),
         firstName: t.firstName,
         lastName: t.lastName,
         dateOfBirth: t.dateOfBirth,
         documentType: t.documentType,
         documentNumberMasked: maskDocumentNumber(t.documentNumber),
         nationality: t.nationality
      })),
   /**
    * Restaurant orders only. The operator dispatching a driver needs the
    * address and the note more than anything else on this record, so it is
    * published whole rather than summarised — including the internal zone id,
    * which the public DTO deliberately omits.
    */
   delivery: (o) => (o as any).delivery ?? undefined,
   consent: (o) =>
      o.consent
         ? {
              policyVersionLabel: o.consent.policyVersionLabel,
              locale: o.consent.locale,
              acceptedAt: o.consent.acceptedAt,
              ip: o.consent.ip,
              textShown: o.consent.textShown
           }
         : undefined,
   documents: (o) =>
      o.documents?.map((d: any) => ({
         id: d._id?.toString(),
         kind: d.kind,
         fileName: d.fileName,
         // Admin surface only: exchanged for a short-lived link, never a URL.
         storageKey: d.storageKey,
         version: d.version,
         uploadedAt: d.uploadedAt,
         uploadedBy: d.uploadedBy
      })),
   timeline: (o) =>
      o.timeline?.map((t: any) => ({
         at: t.at,
         event: t.event,
         detail: t.detail,
         reason: t.reason,
         actorEmail: t.actorEmail
      })),
   internalNotes: (o) => o.internalNotes,
   cancellationReason: (o) => o.cancellationReason,
   version: (o) => (o as any).__v,
}

export const presentOrder = (o: IOrder) => present(o, orderDetailFields)
