import { FieldMap, present } from '../../utils/present'

/**
 * Public order serialiser. §14.3 rule 2: no shared base object with the admin
 * DTO — a separate field list, so a field added to the admin view can never
 * appear here by inheritance.
 *
 * Absent on purpose and permanently: `unitCostPrice`, `lineCost`,
 * `internalNotes`, the customer document, and the raw traveller document
 * numbers (which the schema already marks `select: false` and encrypts).
 * The order's own `_id` is absent too — the public reaches an order by
 * reference, and nothing else.
 */

/** Minor units, per currency, the shape the site's money helpers expect. */
const money = (usd: number, currency?: string, charged?: number) => {
   const out: Record<string, number> = { USD: usd ?? 0 }
   if (currency && currency !== 'USD' && typeof charged === 'number') out[currency] = charged
   return out
}

const itemFields = (currency: string, orderTotalUsd: number, chargedTotal: number) => {
   /** Split the charged total across lines in proportion to their USD share. */
   const share = (lineUsd: number) =>
      orderTotalUsd ? Math.round((lineUsd / orderTotalUsd) * chargedTotal) : 0
   const map: FieldMap<any> = {
      vertical: (i) => i.vertical,
      listingId: (i) => i.listingId?.toString(),
      listingLabel: (i) => i.listingLabel,
      roomTypeId: (i) => i.roomTypeId?.toString(),
      startDate: (i) => i.startDate?.toISOString?.().slice(0, 10),
      endDate: (i) => i.endDate?.toISOString?.().slice(0, 10),
      quantity: (i) => i.quantity,
      unitSellPrice: (i) => money(i.unitSellPrice),
      lineTotal: (i) => money(i.lineTotal, currency, share(i.lineTotal)),
   }
   return map
}

/** §6.2: masked on read. The full number never reaches a public response. */
const mask = (t: any) => {
   const n = t.documentNumber
   if (typeof n !== 'string' || !n.length) return undefined
   return n.length <= 4 ? '••••' : `${'•'.repeat(Math.max(n.length - 4, 2))}${n.slice(-4)}`
}

const travellerFields: FieldMap<any> = {
   firstName: (t) => t.firstName,
   lastName: (t) => t.lastName,
   dateOfBirth: (t) => t.dateOfBirth?.toISOString?.().slice(0, 10),
   documentType: (t) => t.documentType,
   documentNumberMasked: mask,
   nationality: (t) => t.nationality,
}

/**
 * Where a restaurant order is going, as the customer needs to see it back.
 *
 * `fee` and `feeCharged` are included because the delivery charge is part of
 * the total and an unexplained gap between the food and the amount owed is the
 * kind of thing that turns into a doorstep argument with a driver. The zone id
 * is not published — it is an internal handle with nothing to say to a reader.
 */
const deliveryFields: FieldMap<any> = {
   address: (d) => d.address,
   zoneName: (d) => d.zoneName,
   fee: (d) => d.fee,
   feeCharged: (d) => d.feeCharged,
   etaMinutes: (d) => d.etaMinutes,
   notes: (d) => d.notes,
}

const consentFields: FieldMap<any> = {
   policyVersionLabel: (c) => c.policyVersionLabel,
   textShown: (c) => c.textShown,
   locale: (c) => c.locale,
   acceptedAt: (c) => c.acceptedAt?.toISOString?.() ?? c.acceptedAt,
}

const timelineFields: FieldMap<any> = {
   at: (t) => t.at?.toISOString?.() ?? t.at,
   event: (t) => t.event,
   // `detail` and `reason` are internal: they carry operator notes.
}

/**
 * Last four digits only. The holder of the reference booked this order, so
 * confirming which handset the SMS went to is useful — but the full number is
 * PII and has no business travelling to a client that already knows it.
 */
const maskPhone = (p?: string) => {
   if (typeof p !== 'string' || p.length < 4) return undefined
   return `${'•'.repeat(Math.max(p.length - 4, 3))}${p.slice(-4)}`
}

export const presentOrder = (o: any) => {
   const currency = o.chargedCurrency ?? 'USD'
   const items = (o.items ?? []).map((i: any) =>
      present(i, itemFields(currency, o.total ?? 0, o.chargedTotal ?? 0))
   )
   return {
      reference: o.reference,
      // Populated only when the caller asked for it; absent otherwise.
      contactPhoneMasked: maskPhone(o.customer?.phone),
      status: o.status,
      paymentStatus: o.paymentStatus,
      fulfilmentStatus: o.fulfilmentStatus,
      items,
      travellers: (o.travellers ?? []).map((t: any) => present(t, travellerFields)),
      total: money(o.total ?? 0, currency, o.chargedTotal ?? 0),
      chargedCurrency: currency,
      chargedTotal: o.chargedTotal ?? 0,
      fxRate: o.fxRate ?? 1,
      paymentMethod: o.paymentMethod,
      cashDeadline: o.cashDeadline?.toISOString?.(),
      // The number the customer quotes when paying cash at the office. It is
      // the order reference, which they already hold — not a new secret.
      cashReference: o.paymentMethod === 'CASH' ? o.reference : undefined,
      delivery: o.delivery ? present(o.delivery, deliveryFields) : undefined,
      consent: o.consent ? present(o.consent, consentFields) : undefined,
      documents: (o.documents ?? []).map((d: any) => ({ kind: d.kind, fileName: d.fileName })),
      timeline: (o.timeline ?? []).map((t: any) => present(t, timelineFields)),
      travelDate: o.travelDate?.toISOString?.(),
      createdAt: o.createdAt?.toISOString?.(),
   }
}
