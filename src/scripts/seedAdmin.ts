/**
 * Provisions the administrator accounts. There is no signup endpoint on
 * /admin/v1 by design (§1.3), so this script is the only way an admin identity
 * comes into existence.
 *
 *   npm run seed:admin                        # creates/updates the SUPER_ADMIN
 *   npm run seed:admin -- --break-glass       # additionally seals a break-glass account
 *   npm run seed:admin -- --allow-weak-password  # dev only, see below
 *
 * Passwords are read from ADMIN_SEED_PASSWORD / BREAK_GLASS_SEED_PASSWORD so
 * they never appear in shell history or in this file.
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import { ADMIN_ROLES } from '../constants/admin.constants'
import AdminUser from '../model/adminUserModel'
import { validateAdminPassword } from '../utils/passwordPolicy'

/**
 * §1.3 requires 14+ characters checked against a breached-password list. A
 * throwaway local credential should not force that policy to be weakened, so
 * the bypass is explicit, opt-in per run, and refuses to work outside
 * development. The policy itself is untouched — `npm run seed:admin` with no
 * flag still enforces it, and changePassword on the live API always does.
 */
const checkPassword = async (password: string, label: string) => {
   if (process.argv.includes('--allow-weak-password')) {
      if (process.env.NODE_ENV === 'production') {
         throw new Error(
            '--allow-weak-password is refused when NODE_ENV=production'
         )
      }
      console.warn(
         `⚠️  ${label}: password policy bypassed (--allow-weak-password, NODE_ENV=${process.env.NODE_ENV || 'unset'}).\n` +
            '   This credential is unsafe for anything reachable from the internet.'
      )
      return
   }
   const problem = await validateAdminPassword(password)
   if (problem) throw new Error(`${label}: ${problem}`)
}

const run = async () => {
   // Same builder the server uses, so DATABASE_PASSWORD is applied identically.
   const uri = buildMongoUri()

   const email = process.env.ADMIN_SEED_EMAIL
   const password = process.env.ADMIN_SEED_PASSWORD
   const name = process.env.ADMIN_SEED_NAME || 'Administrator'
   if (!email || !password) {
      throw new Error('ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD must be set')
   }

   await checkPassword(password, 'Admin password')

   await mongoose.connect(uri)

   const existing = await AdminUser.findOne({ email: email.toLowerCase() })
   if (existing) {
      existing.password = password
      await existing.save()
      console.log(`Updated password for ${email}`)
   } else {
      await AdminUser.create({
         email,
         name,
         password,
         role: ADMIN_ROLES.SUPER_ADMIN,
         isActive: true,
      })
      console.log(`Created SUPER_ADMIN ${email}`)
   }

   /**
    * §1.2 Risk 1: one account with mandatory 2FA means a lost or wiped phone
    * locks the owner out of his own business permanently, with nobody to reset
    * it. This account is disabled by default; its credentials and recovery
    * codes are printed once, sealed, and stored physically offsite.
    */
   if (process.argv.includes('--break-glass')) {
      const bgEmail = process.env.BREAK_GLASS_SEED_EMAIL
      const bgPassword = process.env.BREAK_GLASS_SEED_PASSWORD
      if (!bgEmail || !bgPassword) {
         throw new Error(
            'BREAK_GLASS_SEED_EMAIL and BREAK_GLASS_SEED_PASSWORD must be set'
         )
      }
      await checkPassword(bgPassword, 'Break-glass password')

      await AdminUser.findOneAndUpdate(
         { email: bgEmail.toLowerCase() },
         {
            email: bgEmail.toLowerCase(),
            name: 'Break-glass account',
            role: ADMIN_ROLES.BREAK_GLASS,
            // Disabled until the documented offsite procedure enables it.
            isActive: false,
         },
         { upsert: true, new: true, setDefaultsOnInsert: true }
      )
      // Set separately so the pre-save hash runs.
      const bg = await AdminUser.findOne({ email: bgEmail.toLowerCase() })
      if (bg) {
         bg.password = bgPassword
         await bg.save()
      }

      console.log(
         `\nSealed break-glass account ${bgEmail} (DISABLED).\n` +
            `Print these credentials, seal them, and store them offsite.\n` +
            `Enabling this account must fire an out-of-band alert (§14.2).\n`
      )
   }

   await mongoose.disconnect()
}

run().catch((err) => {
   console.error(err.message)
   process.exit(1)
})
