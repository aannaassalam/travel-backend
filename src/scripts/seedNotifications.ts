/**
 * Seeds the notification templates the platform needs. English only.
 *
 *   npx ts-node --transpile-only src/scripts/seedNotifications.ts
 *
 * One template per event per channel - there is no locale dimension. An SMS is
 * frequently the first thing sent to a phone number, before any customer record
 * exists to hold a language preference, so operational messages are English and
 * consistent rather than guessed.
 *
 * Re-running replaces the SMS set: these are operational messages, and drift
 * between what the office thinks it sends and what it sends is the problem this
 * seed exists to prevent. Push templates are left alone.
 *
 * Every order template carries {{order_link}}. That link is how a GUEST reaches
 * their booking - they have no account, so without it a cash customer has
 * nothing but a reference read out over the phone.
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { buildMongoUri } from '../config/db.config'
import { NOTIFICATION_EVENTS, NotificationTemplate } from '../model/enquiryModel'

dotenv.config()

const TEMPLATES: { event: string; body: string }[] = [
   {
      event: NOTIFICATION_EVENTS.ORDER_CONFIRMED,
      body: 'Hello {{customer_name}}, your booking {{order_ref}} ({{amount}}) is registered. Track it here: {{order_link}}',
   },
   {
      event: NOTIFICATION_EVENTS.PAYMENT_RECEIVED,
      body: 'Payment received for {{order_ref}}. Thank you {{customer_name}}. Details: {{order_link}}',
   },
   {
      event: NOTIFICATION_EVENTS.CASH_DEADLINE_REMINDER,
      body: 'Reminder: cash payment for {{order_ref}} ({{amount}}) is due by {{deadline}}. {{order_link}}',
   },
   {
      event: NOTIFICATION_EVENTS.DOCUMENTS_ISSUED,
      body: 'Your documents for {{order_ref}} are ready: {{order_link}}',
   },
   {
      event: NOTIFICATION_EVENTS.ORDER_CANCELLED,
      body: 'Your booking {{order_ref}} has been cancelled. Details: {{order_link}}',
   },
   {
      event: NOTIFICATION_EVENTS.ENQUIRY_RECEIVED,
      body: 'Thank you {{customer_name}}, enquiry {{order_ref}} received. We will call you shortly.',
   },
   {
      event: NOTIFICATION_EVENTS.QUOTE_SENT,
      body: 'Your quote for {{order_ref}} is ready: {{amount}}. We will be in touch.',
   },
]

async function main() {
   await mongoose.connect(buildMongoUri())
   console.log(`connected to ${mongoose.connection.name}`)

   /**
    * The old unique index was on (event, locale, channel). Mongo keeps
    * enforcing an index the schema no longer declares, so leaving it behind
    * would let two templates exist for one event+channel - and the dispatcher
    * would then pick one of them arbitrarily.
    */
   const collection = NotificationTemplate.collection
   for (const index of await collection.indexes()) {
      if (index.key && 'locale' in index.key) {
         await collection.dropIndex(index.name as string)
         console.log(`dropped stale index ${index.name}`)
      }
   }

   const removed = await NotificationTemplate.deleteMany({ channel: 'SMS' })
   console.log(`removed ${removed.deletedCount} old SMS template(s)`)

   for (const row of TEMPLATES) {
      await NotificationTemplate.create({ ...row, channel: 'SMS', isActive: true })
   }
   await NotificationTemplate.syncIndexes()

   const all = await NotificationTemplate.find().sort({ event: 1 })
   console.log(`\n${all.length} templates:`)
   for (const t of all) console.log(`  ${t.event.padEnd(24)} ${t.channel}`)
   await mongoose.disconnect()
}

main().catch((e) => {
   console.error(e.message)
   process.exit(1)
})
