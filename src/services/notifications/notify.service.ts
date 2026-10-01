import { Types } from 'mongoose'
import {
   NOTIFICATION_EVENTS,
   NotificationLog,
   NotificationTemplate,
   TEMPLATE_VARIABLES,
} from '../../model/enquiryModel'
import { Customer } from '../../model/customerModel.admin'
import { Order } from '../../model/orderModel'
import { sendSms, smsConfigured } from './sms.service'
import { activeDevices, pushConfigured, sendPush } from './push.service'

/**
 * Sending the messages the admin's Notifications screen configures.
 *
 * The screen was previously a template editor attached to nothing — an operator
 * could write a confirmation SMS, save it, and no customer would ever receive
 * it. This is the part that fires.
 *
 * Design rules, both learned the hard way in this codebase:
 *
 * 1. A notification NEVER breaks the thing that triggered it. A customer who
 *    has paid must not see checkout fail because Twilio was down. Every send is
 *    caught, logged with its failure, and swallowed.
 * 2. Every attempt is logged, including the ones that go nowhere. §11 says
 *    support must be able to answer "was it delivered?" in one search, and an
 *    unsent message is the exact case they will be asked about.
 */

export type NotificationEvent =
   (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS]

/** Only the documented variables; anything else is a template author's typo. */
export type TemplateVars = Partial<
   Record<(typeof TEMPLATE_VARIABLES)[number], string | number | undefined>
>

export interface NotifyInput {
   event: NotificationEvent
   /** E.164. The handset for SMS, the account for push. */
   recipient: string
   vars?: TemplateVars
   order?: Types.ObjectId
   /**
    * Text that must reach the customer whether or not the template mentions it.
    * Used for the order tracking link, which a guest cannot do without.
    */
   appendIfMissing?: { token: string; text: string }
   /** The customer to reach by push first, when they have the app. */
   customer?: Types.ObjectId
}

/**
 * Substitutes {{variable}} placeholders.
 *
 * An unknown or missing variable renders as an empty string rather than leaving
 * "{{deadline}}" in a message a customer reads. `upsertTemplate` already
 * rejects unknown names on save, so this is the runtime backstop for a value
 * the caller simply did not have.
 */
export const render = (body: string, vars: TemplateVars = {}) =>
   body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, key: string) => {
      const value = (vars as Record<string, unknown>)[key]
      return value === undefined || value === null ? '' : String(value)
   })

/**
 * Messages that still go by SMS to someone who has the app.
 *
 * Push can be silenced per app, and missing either of these costs the
 * customer their booking: the cash deadline is the last warning before it is
 * cancelled, and a cancellation must reach them. Everything else goes by push
 * alone when push can reach them — which is where the Twilio saving comes from.
 */
const SMS_EVEN_WITH_APP = new Set<string>([
   NOTIFICATION_EVENTS.CASH_DEADLINE_REMINDER,
   NOTIFICATION_EVENTS.ORDER_CANCELLED,
])

/**
 * The SMS wording, made fit for a notification.
 *
 * Tapping a push opens the booking, so the web link is rendered empty — which
 * leaves SMS templates ending in a label with nothing after it ("Track it
 * here:"). That trailing label is dropped, back to the end of the sentence
 * before it. A template written for push has no such tail and passes through.
 */
export const pushBody = (template: string, vars: TemplateVars) => {
   const text = render(template, { ...vars, order_link: '' }).trim()
   if (!text.endsWith(':')) return text
   const end = Math.max(text.lastIndexOf('. '), text.lastIndexOf('! '), text.lastIndexOf('? '))
   return end > 0 ? text.slice(0, end + 1) : `${text.slice(0, -1)}.`
}

/** The app's title line; the template is the body. */
const PUSH_TITLE = 'Flexi Agency'

/**
 * Fires one event to one recipient. Resolves to the number of messages sent.
 *
 * Push first, SMS otherwise: when `customer` is given and that customer has a
 * signed-in app install, the message goes as a push notification and the SMS
 * is skipped (bar SMS_EVEN_WITH_APP). No app, push not configured, or every
 * push refused — then SMS, exactly as before push existed. A guest never has
 * an app install, so a guest always gets the SMS with their booking link.
 */
export const notify = async ({
   event,
   recipient,
   vars = {},
   order,
   appendIfMissing,
   customer,
}: NotifyInput): Promise<number> => {
   let sent = 0
   try {
      const templates = await NotificationTemplate.find({ event, isActive: true })
      if (!templates.length) return 0

      // One template per channel - the unique index guarantees it.
      const byChannel = new Map<string, (typeof templates)[number]>()
      for (const t of templates) byChannel.set(t.channel, t)

      // ------------------------------------------------------------- push
      let pushed = false
      const pushTemplate = byChannel.get('PUSH') ?? byChannel.get('SMS')
      if (customer && pushTemplate && pushConfigured()) {
         const devices = await activeDevices(customer)
         if (devices.length) {
            const body = pushBody(pushTemplate.body, vars)
            const log = { event, channel: 'PUSH', recipient, order, body }
            try {
               const result = await sendPush(
                  devices.map((d) => d.token),
                  {
                     title: PUSH_TITLE,
                     body,
                     data: { event, reference: String(vars.order_ref ?? '') },
                  }
               )
               pushed = result.delivered > 0
               await NotificationLog.create({
                  ...log,
                  status: pushed ? 'SENT' : 'FAILED',
                  providerMessage: `${result.delivered} of ${devices.length} device(s)${
                     result.error ? ` — ${result.error}` : ''
                  }`,
               })
               if (pushed) sent++
            } catch (err) {
               await NotificationLog.create({
                  ...log,
                  status: 'FAILED',
                  providerMessage: (err as Error).message.slice(0, 300),
               })
            }
         }
      }

      // -------------------------------------------------------------- SMS
      const template = byChannel.get('SMS')
      if (template && (!pushed || SMS_EVEN_WITH_APP.has(event))) {
         const source =
            appendIfMissing && !template.body.includes(appendIfMissing.token)
               ? template.body + appendIfMissing.text
               : template.body
         const body = render(source, vars)
         const log = { event, channel: 'SMS', recipient, order, body }

         try {
            if (!smsConfigured()) {
               await NotificationLog.create({
                  ...log,
                  status: 'FAILED',
                  providerMessage: 'SMS provider is not configured',
               })
            } else {
               const result = await sendSms(recipient, body)
               await NotificationLog.create({
                  ...log,
                  status: 'SENT',
                  providerMessage: `${result.sid} (${result.status})`,
                  costMinor: result.costMinor,
               })
               sent++
            }
         } catch (err) {
            // Provider refused. Recorded, never rethrown.
            await NotificationLog.create({
               ...log,
               status: 'FAILED',
               providerMessage: (err as Error).message.slice(0, 300),
            })
         }
      }
   } catch (err) {
      // A notification must never take down the booking that triggered it.
      console.error(`[notify] ${event} failed:`, (err as Error).message)
   }
   return sent
}

/**
 * Where a customer goes to see their own booking.
 *
 * The reference already IS the read capability (it carries ~50 bits of entropy
 * and `GET /orders/:reference` asks for nothing else), so this link works for a
 * guest exactly as it does for a signed-in customer. That is the point: someone
 * who chose not to create an account must still be able to check what they
 * bought.
 */
export const orderLink = (reference: string) => {
   const base = (process.env.PUBLIC_SITE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '')
   return base ? `${base}/booking/confirmation/${reference}` : ''
}

/** Money for a template, from minor units. */
export const money = (minor: number, currency = 'USD') =>
   `${(minor / 100).toFixed(2)} ${currency}`

/** Dates read by a person, not an ISO string. */
export const day = (d?: Date | string | null) =>
   d ? new Date(d).toISOString().slice(0, 10) : ''

/**
 * Fires an order event, filling the template variables from the order itself.
 *
 * Call sites pass an id and nothing else. Centralising the lookup is what keeps
 * `{{amount}}` meaning the same thing in every message — a confirmation that
 * quotes a different total from the receipt is worse than no message at all.
 */
export const notifyOrder = async (event: NotificationEvent, orderId: Types.ObjectId) => {
   try {
      const order = await Order.findById(orderId)
      if (!order) return 0
      const customer = await Customer.findById(order.customer)
      if (!customer?.phone) return 0

      const link = orderLink(order.reference)

      return await notify({
         event,
         recipient: customer.phone,
         /**
          * The tracking link is appended when the template does not already
          * place it. A guest has no other way back to their booking, so it must
          * not depend on whoever last edited the template remembering to
          * include the variable.
          */
         appendIfMissing: link
            ? { token: '{{order_link}}', text: `\n${link}` }
            : undefined,
         order: order._id,
         customer: customer._id,
         vars: {
            customer_name: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
            order_ref: order.reference,
            amount: money(order.chargedTotal, order.chargedCurrency),
            currency: order.chargedCurrency,
            departure_date: day(order.travelDate),
            listing_title: order.items?.[0]?.listingLabel ?? '',
            deadline: day(order.cashDeadline),
            order_link: link,
         },
      })
   } catch (err) {
      console.error(`[notify] ${event} for order failed:`, (err as Error).message)
      return 0
   }
}
