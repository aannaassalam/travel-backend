/**
 * READ-ONLY. §BUG-017: `platform_customers.phone` is now declared unique, and a
 * unique index cannot build while two rows share a phone. This lists the
 * collection's indexes (is `phone_1` unique yet?) and every duplicate group,
 * with enough per-row detail to pick a survivor. It never writes — not even an
 * index: the connection is opened with `autoIndex: false` so Mongoose does not
 * try to build the unique index as a side effect of loading the model.
 *
 *   npx ts-node src/scripts/checkDuplicatePhones.ts
 *
 * Phones are printed masked (first 4 + **** + last 3).
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import { Customer } from '../model/customerModel.admin'
import { Order } from '../model/orderModel'

const mask = (phone: string) =>
   phone.length <= 7 ? '****' : `${phone.slice(0, 4)}****${phone.slice(-3)}`

const run = async () => {
   await mongoose.connect(buildMongoUri(), { autoIndex: false })

   const indexes = await Customer.collection.indexes()
   console.log('Indexes on platform_customers:')
   for (const ix of indexes) {
      console.log(`  ${ix.name}  key=${JSON.stringify(ix.key)}  unique=${ix.unique === true}`)
   }

   // Read-only (listIndexes under the hood): what Customer.syncIndexes() would
   // do. A `phone_1` that exists but is not unique shows up here as drop+create —
   // autoIndex alone cannot upgrade it, MongoDB refuses a createIndex whose name
   // already exists with different options (IndexOptionsConflict, code 85).
   const diff = await Customer.diffIndexes()
   console.log(`\nsyncIndexes() would drop: ${JSON.stringify(diff.toDrop)}`)
   console.log(`syncIndexes() would create: ${JSON.stringify(diff.toCreate)}`)

   const groups: Array<{
      _id: string
      count: number
      docs: Array<{ _id: mongoose.Types.ObjectId; hasAccount?: boolean; isBlocked?: boolean; createdAt?: Date }>
   }> = await Customer.aggregate([
      {
         $group: {
            _id: '$phone',
            count: { $sum: 1 },
            docs: {
               $push: {
                  _id: '$_id',
                  hasAccount: '$hasAccount',
                  isBlocked: '$isBlocked',
                  createdAt: '$createdAt',
               },
            },
         },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1, _id: 1 } },
   ])

   const affected = groups.reduce((n, g) => n + g.count, 0)
   console.log(`\nDuplicate phone groups: ${groups.length}`)
   console.log(`Affected docs: ${affected}`)

   for (const g of groups) {
      console.log(`\n${mask(String(g._id))}  x${g.count}`)
      for (const d of g.docs) {
         const orders = await Order.countDocuments({ customer: d._id })
         console.log(
            `  _id=${d._id}  hasAccount=${d.hasAccount === true}  isBlocked=${d.isBlocked === true}` +
               `  createdAt=${d.createdAt ? d.createdAt.toISOString() : '-'}  orders=${orders}`
         )
      }
   }

   await mongoose.disconnect()
}

run().catch((err) => {
   console.error(err.message)
   process.exit(1)
})
