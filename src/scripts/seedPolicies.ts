/**
 * Seeds the legal text the public site used to hardcode into `PolicyVersion`
 * documents, so the admin's content section becomes the source of truth.
 *
 *   npx ts-node --transpile-only src/scripts/seedPolicies.ts
 *
 * Additive and idempotent: it creates nothing that already exists at the same
 * kind+locale+label, and it deletes nothing — the model forbids that anyway,
 * because historical orders reference these versions (§10).
 *
 * The texts themselves live in constants/policy.defaults.ts, which the panel's
 * legal editor also reads.
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { buildMongoUri } from '../config/db.config'
import { POLICY_DEFAULTS } from '../constants/policy.defaults'
import { PolicyVersion } from '../model/settingsModel'

dotenv.config()

// One entry per text and language, each published as v1.0.
const SEED = Object.entries(POLICY_DEFAULTS).flatMap(([kind, byLocale]) =>
   Object.entries(byLocale).map(([locale, body]) => ({ kind, locale, label: 'v1.0', body }))
)

async function main() {
   // Same builder the server uses, so DATABASE_PASSWORD is applied identically.
   await mongoose.connect(buildMongoUri())
   // Never print the URI — it carries the Atlas password.
   console.log(`connected to ${mongoose.connection.name}\n`)

   for (const entry of SEED) {
      const existing = await PolicyVersion.findOne({
         kind: entry.kind,
         locale: entry.locale,
         label: entry.label,
      })
      if (existing) {
         // Text is immutable by design, so a re-run must not try to update it.
         if (!existing.isLive) {
            existing.isLive = true
            await existing.save()
            console.log(`  ${entry.kind}/${entry.locale}  existed -> set live`)
         } else {
            console.log(`  ${entry.kind}/${entry.locale}  already live, skipped`)
         }
         continue
      }

      // Exactly one live version per kind+locale, same rule setPolicyLive enforces.
      const siblings = await PolicyVersion.find({
         kind: entry.kind,
         locale: entry.locale,
         isLive: true,
      })
      for (const s of siblings) {
         s.isLive = false
         await s.save()
      }

      await PolicyVersion.create({ ...entry, isLive: true, wentLiveAt: new Date() })
      console.log(`  ${entry.kind}/${entry.locale}  created, live (${entry.body.length} chars)`)
   }

   const live = await PolicyVersion.countDocuments({ isLive: true })
   console.log(`\n${live} live policy versions in ${mongoose.connection.name}`)
   await mongoose.disconnect()
}

main().catch((e) => {
   console.error(e.message)
   process.exit(1)
})
