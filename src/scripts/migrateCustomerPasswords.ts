/**
 * Gives every pre-existing account a password, so nobody who already had one
 * is locked out by the switch from "SMS code every time" to "SMS code once,
 * then a password".
 *
 *   npm run migrate:customer-passwords            # report only
 *   npm run migrate:customer-passwords -- --apply # write
 *
 * The default is `12345678`, as agreed. It is a known password on a live
 * account, which is only acceptable because it is temporary — the customers it
 * covers should be told to change it, and "Forgot password" already reissues
 * one over SMS for anyone who does not read the notice.
 *
 * Idempotent: an account that already has a password is skipped, so re-running
 * never overwrites one a customer chose. Dry-run by default, like every other
 * migration here.
 *
 * ponytail: no per-customer random passwords and no forced-change flag — the
 * brief asked for one shared default. Add a `mustChangePassword` field if the
 * office wants to force a reset on next sign-in.
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import { hashPassword } from '../middleware/customerAuth'
import { Customer } from '../model/customerModel.admin'

const DEFAULT_PASSWORD = '12345678'
const apply = process.argv.includes('--apply')

const run = async () => {
   await mongoose.connect(buildMongoUri())

   // Accounts only. A guest checkout files a contact record, not a login, and
   // handing one a working password would turn it into an account nobody asked
   // for — and one whose phone was never proved.
   const filter = { hasAccount: true, password: { $exists: false } }
   const pending = await Customer.find(filter).select('phone firstName')

   for (const c of pending) {
      console.log(`  ${c.phone}  ${c.firstName ?? ''}`)
   }

   if (apply && pending.length) {
      // One hash for all of them: bcrypt is deliberately slow, and hashing the
      // same string once per customer would make this take minutes for nothing.
      const hash = await hashPassword(DEFAULT_PASSWORD)
      await Customer.updateMany(filter, { $set: { password: hash } })
   }

   console.log(
      pending.length === 0
         ? '\nNothing to do — every account already has a password.'
         : apply
           ? `\nSet the default password on ${pending.length} account(s).`
           : `\n${pending.length} account(s) would get the default password. Re-run with --apply to write.`
   )
   await mongoose.disconnect()
}

run().catch((e) => {
   console.error(e)
   process.exit(1)
})
