import { Types } from 'mongoose'

import { Customer } from '../../model/customerModel.admin'
import { NotificationLog } from '../../model/enquiryModel'
import { Order } from '../../model/orderModel'
import { Ride } from '../../model/rideModel'
import { getSettings, ISettings } from '../../model/settingsModel'
import { emailConfigured, sendEmail } from '../../utils/email_sms'
import { rideVars } from '../transfers/rideVars'
import { day, money, orderLink, travelWhen } from './notify.service'

/**
 * The office's e-mail at each stage of a booking (owner, 2026-10-26), so a
 * booking is seen without anyone watching the panel. Fixed wording, in English
 * like the panel; every attempt is in the delivery log (channel EMAIL, event
 * OFFICE_<stage>).
 */
export type BookingStage = 'NEW' | 'NEW_PAID' | 'PAID' | 'CONFIRMED' | 'DOCUMENTS' | 'COMPLETED'

const SUBJECT: Record<BookingStage, (ref: string) => string> = {
   NEW: (ref) => `New booking ${ref}`,
   NEW_PAID: (ref) => `New booking ${ref}, paid online`,
   PAID: (ref) => `Payment received ${ref}`,
   CONFIRMED: (ref) => `Booking confirmed ${ref}`,
   DOCUMENTS: (ref) => `Documents attached ${ref}`,
   COMPLETED: (ref) => `Booking completed ${ref}`,
}

const OPENING: Record<BookingStage, (order: any, ride?: unknown) => string> = {
   // NEW is a cash booking; a ride's fare goes to the driver.
   NEW: (order, ride) =>
      ride
         ? 'A new booking was made, to be paid to the driver in cash.'
         : `A new booking was made, to be paid in cash at the office by ${day(order.cashDeadline)}.`,
   NEW_PAID: () => 'A new booking was made and paid online.',
   PAID: () => 'The payment was recorded and the booking is confirmed.',
   CONFIRMED: () => 'The booking was confirmed.',
   // The batch just attached, as the timeline records it ("ETICKET v1, VOUCHER v1").
   DOCUMENTS: (order) =>
      `Documents were attached: ${
         (order.timeline ?? []).filter((t: any) => t.event === 'DOCUMENTS_ISSUED').pop()?.detail ||
         (order.documents ?? []).map((d: any) => `${d.kind} v${d.version}`).join(', ')
      }.`,
   COMPLETED: () => 'The booking was marked completed.',
}

const FOOTER =
   'Sent automatically at each stage of a booking. Change the address in the admin: Settings → Support email.'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
/** Every value is escaped: names, labels and places are typed by customers and staff. */
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])

/**
 * The e-mail for one stage of one order, as subject, HTML and plain text. Pure,
 * so it can be checked without sending. No traveller data beyond a count: no
 * names, no document numbers.
 */
export const officeMail = (stage: BookingStage, order: any, customer: any, ride?: any) => {
   const items: any[] = order.items ?? []
   const first = items[0]
   const rv = ride ? rideVars(ride) : null
   const route = rv ? `${rv.pickup} → ${rv.dropoff}` : ''
   const vertical = first?.vertical ? first.vertical.charAt(0) + first.vertical.slice(1).toLowerCase() : ''
   const people = ride?.passengers ?? order.travellers?.length
   const rows: [string, string][] = [
      ['Reference', order.reference],
      [
         'Service',
         [vertical, first?.listingLabel].filter(Boolean).join(' · ') +
            (items.length > 1 ? ` (+${items.length - 1} more)` : ''),
      ],
      ['Date', rv ? `${route}, ${rv.departure_date}` : travelWhen(order)],
      [
         'Quantity / travellers',
         [items.reduce((n, i) => n + (i.quantity ?? 0), 0), people && `${people} traveller${people > 1 ? 's' : ''}`]
            .filter(Boolean)
            .join(' · '),
      ],
      ['Customer name', [customer?.firstName, customer?.lastName].filter(Boolean).join(' ')],
      ['Phone', customer?.phone ?? ''],
      ...(customer?.email ? [['E-mail', customer.email] as [string, string]] : []),
      ['Amount', money(order.chargedTotal, order.chargedCurrency)],
      ['Payment', `${order.paymentMethod} · ${order.paymentStatus}`],
      ['Status', order.status],
   ]
   const admin = (process.env.ADMIN_URL || '').replace(/\/$/, '')
   const links = [
      admin && ['Open it in the admin', `${admin}/bookings/${order._id}`],
      orderLink(order.reference) && ["The customer's page", orderLink(order.reference)],
   ].filter(Boolean) as [string, string][]

   const lead = OPENING[stage](order, ride)
   return {
      // One line, whatever the label holds.
      subject: [SUBJECT[stage](order.reference), route || first?.listingLabel]
         .filter(Boolean)
         .join(' — ')
         .replace(/\s+/g, ' '),
      html:
         `<p>${esc(lead)}</p>` +
         '<table cellpadding="6" style="border-collapse:collapse;font-size:14px">' +
         rows.map(([k, v]) => `<tr><td style="color:#666">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') +
         '</table>' +
         links.map(([k, href]) => `<p><a href="${esc(href)}">${esc(k)}</a></p>`).join('') +
         `<p style="color:#888;font-size:12px">${esc(FOOTER)}</p>`,
      text: [lead, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', ...links.map(([k, href]) => `${k}: ${href}`), '', FOOTER].join(
         '\n'
      ),
   }
}

/** Settings → Support email, else the primary office's, else the mailbox that sends. */
const officeAddress = (settings: ISettings) =>
   [settings.supportEmail, settings.offices?.find((o) => o.isPrimary)?.email, process.env.EMAIL_FROM, process.env.EMAIL_USERNAME]
      .map((a) => (a ?? '').trim())
      .find(Boolean) ?? ''

/**
 * E-mails the office about one stage of a booking. Never throws: callers do
 * not await it, and every attempt — sent or not — goes in the delivery log.
 */
export const emailOffice = async (stage: BookingStage, orderId: Types.ObjectId): Promise<void> => {
   const row: Record<string, unknown> = { event: `OFFICE_${stage}`, channel: 'EMAIL', recipient: 'office', order: orderId }
   const record = (status: 'SENT' | 'FAILED', providerMessage: string) =>
      NotificationLog.create({ ...row, status, providerMessage: providerMessage.slice(0, 300) })
   try {
      const order = await Order.findById(orderId)
      if (!order) return
      const [customer, ride, settings] = await Promise.all([
         Customer.findById(order.customer).select('firstName lastName phone email'),
         order.items?.[0]?.vertical === 'TRANSFER' ? Ride.findOne({ order: order._id }) : null,
         getSettings(),
      ])
      const mail = officeMail(stage, order, customer, ride)
      row.body = mail.subject.slice(0, 1000)
      const to = officeAddress(settings)
      if (!to) {
         await record('FAILED', 'No office e-mail address in Settings')
         return
      }
      row.recipient = to
      if (!emailConfigured()) {
         await record('FAILED', 'E-mail is not configured')
         return
      }
      await sendEmail({ email: to, subject: mail.subject, html: mail.html, text: mail.text })
      await record('SENT', 'Accepted by the mail server')
   } catch (err) {
      await record('FAILED', (err as Error).message).catch((e) =>
         console.error(`[office e-mail] ${stage} for ${orderId} could not be logged:`, (e as Error).message)
      )
   }
}
