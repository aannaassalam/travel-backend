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
 * Fires one event to one recipient on every channel the office has configured
 * for it. Resolves to the number of messages actually sent.
 */
export const notify = async ({
   event,
   recipient,
   vars = {},
   order,
   appendIfMissing,
}: NotifyInput): Promise<number> => {
   let sent = 0
   try {
      const templates = await NotificationTemplate.find({ event, isActive: true })
      if (!templates.length) return 0

      // One template per channel - the unique index guarantees it.
      const byChannel = new Map<string, (typeof templates)[number]>()
      for (const t of templates) byChannel.set(t.channel, t)

      for (const template of byChannel.values()) {
         const source =
            appendIfMissing && !template.body.includes(appendIfMissing.token)
               ? template.body + appendIfMissing.text
               : template.body
         const body = render(source, vars)
         const log = {
            event,
            channel: template.channel,
            recipient,
            order,
            body,
         }

         try {
            if (template.channel === 'SMS') {
               if (!smsConfigured()) {
                  await NotificationLog.create({
                     ...log,
                     status: 'FAILED',
                     providerMessage: 'SMS provider is not configured',
                  })
                  continue
               }
               const result = await sendSms(recipient, body)
               await NotificationLog.create({
                  ...log,
                  status: 'SENT',
                  providerMessage: `${result.sid} (${result.status})`,
                  costMinor: result.costMinor,
               })
               sent++
            } else if (template.channel === 'PUSH') {
               /**
                * ponytail: push needs a device-token registry and a provider
                * (FCM/APNs), neither of which exists — there is no mobile app
                * yet to register one. Logged as QUEUED rather than SENT so the
                * delivery log tells the truth: the office can see the event
                * fired and that nothing was transmitted. Wire the provider here
                * and the templates already written start working unchanged.
                */
               await NotificationLog.create({
                  ...log,
                  status: 'QUEUED',
                  providerMessage: 'Push provider not configured — nothing transmitted',
               })
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
