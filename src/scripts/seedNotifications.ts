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
 * So it is for a fresh database: on a live one it would wipe the office's own
 * wording. A live database needs nothing run — every boot adds the default of
 * any event with no SMS template, bar one the office deleted
 * (ensureDefaultTemplates), and leaves the rest.
 * The texts live in constants/notificationTemplates.defaults.ts.
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { buildMongoUri } from '../config/db.config'
import { NOTIFICATION_TEMPLATE_DEFAULTS } from '../constants/notificationTemplates.defaults'
import { NotificationTemplate } from '../model/enquiryModel'

dotenv.config()

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
   // A fresh database has no collection yet, and listing its indexes throws.
   await NotificationTemplate.createCollection()
   for (const index of await collection.indexes()) {
      if (index.key && 'locale' in index.key) {
         await collection.dropIndex(index.name as string)
         console.log(`dropped stale index ${index.name}`)
      }
   }

   const removed = await NotificationTemplate.deleteMany({ channel: 'SMS' })
   console.log(`removed ${removed.deletedCount} old SMS template(s)`)

   for (const row of NOTIFICATION_TEMPLATE_DEFAULTS) {
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
