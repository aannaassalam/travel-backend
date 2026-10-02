/**
 * §BUG-017 one-off: upgrade `platform_customers.phone_1` to UNIQUE.
 *
 * Mongoose autoIndex cannot do this by itself: MongoDB refuses a createIndex whose
 * name already exists with different options (IndexOptionsConflict, code 85) and
 * Mongoose swallows that rejection, so the schema's `unique: true` silently never
 * takes effect. syncIndexes() drops the stale non-unique phone_1 and creates the
 * unique one. Refuses to run if any duplicate phones exist (merge them first — see
 * checkDuplicatePhones.ts) or against NODE_ENV=production.
 *
 *   npx ts-node src/scripts/syncCustomerIndexes.ts
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import { Customer } from '../model/customerModel.admin'

const show = async (label: string) => {
   console.log(label)
   for (const ix of await Customer.collection.indexes()) {
      console.log(`  ${ix.name}  key=${JSON.stringify(ix.key)}  unique=${ix.unique === true}`)
   }
}

const run = async () => {
   if (process.env.NODE_ENV === 'production') throw new Error('refusing to run against NODE_ENV=production')
   await mongoose.connect(buildMongoUri(), { autoIndex: false })
   const dupes = await Customer.aggregate([
      { $group: { _id: '$phone', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $count: 'groups' },
   ])
   const groups = dupes[0]?.groups ?? 0
   if (groups > 0) throw new Error(`${groups} duplicate phone group(s) exist — merge them first`)
   await show('before:')
   const diff = await Customer.diffIndexes()
   console.log(`plan: drop ${JSON.stringify(diff.toDrop)}  create ${JSON.stringify(diff.toCreate)}`)
   await Customer.syncIndexes()
   await show('after:')
   await mongoose.disconnect()
}

run().catch((e) => {
   console.error(e.message)
   process.exit(1)
})
