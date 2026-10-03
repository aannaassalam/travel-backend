/**
 * READ-ONLY: why did a customer get SMS instead of push?
 * Prints the account's device tokens (active = seen within ACTIVE_DEVICE_MS), the last
 * notification sends to that phone (event / channel / status / provider message), and
 * whether push and SMS are configured on THIS backend. Never writes.
 *   npx ts-node src/scripts/checkNotificationRouting.ts +917044804030
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'
dotenv.config()
import { buildMongoUri } from '../config/db.config'
import { Customer } from '../model/customerModel.admin'
import { ACTIVE_DEVICE_MS, DeviceToken } from '../model/deviceTokenModel'
import { NotificationLog } from '../model/enquiryModel'
import { pushConfigured } from '../services/notifications/push.service'
import { smsConfigured } from '../services/notifications/sms.service'

const phone = process.argv[2]
const run = async () => {
   await mongoose.connect(buildMongoUri(), { autoIndex: false })
   console.log(`pushConfigured=${pushConfigured()}  smsConfigured=${smsConfigured()}  ACTIVE_DEVICE_MS=${ACTIVE_DEVICE_MS / 3600000}h`)
   const customers = await Customer.find({ phone }).select('_id firstName hasAccount createdAt').lean()
   console.log(`customers with phone ${phone.slice(0, 4)}****${phone.slice(-3)}: ${customers.length}`)
   for (const c of customers) {
      const devices = await DeviceToken.find({ customer: c._id }).lean()
      console.log(` customer ${c._id} (${c.firstName}, hasAccount=${c.hasAccount}) device tokens: ${devices.length}`)
      for (const d of devices as any[]) {
         const ageH = (Date.now() - new Date(d.lastSeenAt).getTime()) / 3600000
         console.log(`   - ${d.platform} lastSeenAt=${new Date(d.lastSeenAt).toISOString()} (${ageH.toFixed(1)}h ago) active=${ageH * 3600000 < ACTIVE_DEVICE_MS} token=${String(d.token).slice(0, 10)}…`)
      }
   }
   const logs = await (NotificationLog as any).find({ recipient: phone }).sort({ createdAt: -1 }).limit(20).lean()
   console.log(`\nlast ${logs.length} notification sends to this number (newest first):`)
   for (const l of logs) console.log(`  ${new Date(l.createdAt).toISOString()}  ${l.event.padEnd(24)} ${l.channel.padEnd(5)} ${l.status.padEnd(7)} ${(l.providerMessage ?? '').slice(0, 70)}`)
   const byEvChan: Record<string, number> = {}
   for (const l of await (NotificationLog as any).find({ recipient: phone }).select('event channel status').lean()) { const k = `${l.event}/${l.channel}/${l.status}`; byEvChan[k] = (byEvChan[k] || 0) + 1 }
   console.log('\nall-time counts event/channel/status:', JSON.stringify(byEvChan, null, 1))
   await mongoose.disconnect()
}
run().catch((e) => { console.error(e.message); process.exit(1) })
