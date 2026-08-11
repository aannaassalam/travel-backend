/**
 * Migrates records written before names were localised and prices became
 * per-currency.
 *
 *   npm run migrate:i18n-money            # report only
 *   npm run migrate:i18n-money -- --apply # write
 *
 *   "Hôtel Memling"  ->  { fr: "Hôtel Memling" }
 *   12000            ->  { USD: 12000 }
 *
 * Idempotent: anything already in the new shape is skipped, so re-running is
 * safe. Dry-run by default — the same rule the CSV import follows, for the same
 * reason.
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import { DEFAULT_LOCALE } from '../constants/domain.constants'

const apply = process.argv.includes('--apply')

const toLocalized = (v: any) =>
   typeof v === 'string' ? { [DEFAULT_LOCALE]: v } : null

const toMoney = (v: any) => (typeof v === 'number' ? { USD: v } : null)

const run = async () => {
   await mongoose.connect(buildMongoUri())
   const db = mongoose.connection.db!
   let changed = 0

   const migrate = async (
      collection: string,
      textFields: string[],
      moneyFields: string[]
   ) => {
      const docs = await db.collection(collection).find({}).toArray()
      for (const doc of docs) {
         const set: Record<string, any> = {}
         textFields.forEach((f) => {
            const converted = toLocalized(doc[f])
            if (converted) set[f] = converted
         })
         moneyFields.forEach((f) => {
            const converted = toMoney(doc[f])
            if (converted) set[f] = converted
         })
         if (!Object.keys(set).length) continue

         changed += 1
         console.log(
            `  ${collection}/${doc._id}: ${Object.entries(set)
               .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
               .join(' ')}`
         )
         if (apply) {
            await db.collection(collection).updateOne({ _id: doc._id }, { $set: set })
         }
      }
   }

   await migrate('hotels', ['name', 'description'], [])
   await migrate('roomtypes', ['name', 'description'], [])
   await migrate('rateplans', [], ['costPrice', 'sellPrice'])
   await migrate('listings', ['title', 'description'], ['costPrice', 'sellPrice'])

   console.log(
      changed === 0
         ? '\nNothing to migrate — everything is already in the new shape.'
         : apply
           ? `\nMigrated ${changed} document(s).`
           : `\n${changed} document(s) would change. Re-run with --apply to write.`
   )
   await mongoose.disconnect()
}

run().catch((e) => {
   console.error(e.message)
   process.exit(1)
})
