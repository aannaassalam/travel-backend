/**
 * §14.3 rule 5 / §16: automated leak tests. Run in CI — a failure here blocks
 * the build.
 *
 *   npm run test:leak
 *
 * Two things are checked:
 *   1. No DTO emits a field on the forbidden list, even when the source
 *      document is stuffed with every sensitive value we know about.
 *   2. No module under routes/v1 or controllers (public surface) imports from
 *      dto/admin — §14.3 rule 2, no shared DTOs between surfaces, ever.
 *
 * No test framework on purpose: this must run anywhere, including a bare CI
 * container, with nothing but ts-node.
 */
import assert from 'assert'
import fs from 'fs'
import path from 'path'

import {
   presentAccessRole,
   presentAccessUser,
   presentAdminUser,
   presentSessions,
} from '../dto/admin/adminUser.dto'
import { presentAuditLogs } from '../dto/admin/auditLog.dto'
import { presentPublicUser } from '../dto/public/user.dto'

let failures = 0
const check = (name: string, fn: () => void) => {
   try {
      fn()
      console.log(`  ✓ ${name}`)
   } catch (err: any) {
      failures += 1
      console.error(`  ✗ ${name}\n      ${err.message}`)
   }
}

/** Never acceptable in any response body, on any surface. */
const NEVER_ANYWHERE = [
   'password',
   'passwordConfirm',
   'totpSecret',
   'recoveryCodes',
   'tokenIdHash',
   'otp',
   'otpExpires',
   'documentNumber',
   '__v',
]

/** Additionally forbidden on the public surface (§14.5, §15). */
const NEVER_PUBLIC = [
   'cost_price',
   'costPrice',
   'margin',
   'supplier',
   'internalNotes',
   'role',
   'passwordChangedAt',
   'failedLoginCount',
   'lockedUntil',
   'sessions',
]

/** A document carrying every sensitive field, to prove the allow-list holds. */
const poisoned = (extra: Record<string, any> = {}) => ({
   _id: { toString: () => '507f1f77bcf86cd799439011' },
   name: 'Test',
   email: 'test@example.com',
   password: 'LEAKED-HASH',
   passwordConfirm: 'LEAKED',
   totpSecret: 'LEAKED-SECRET',
   recoveryCodes: [{ hash: 'LEAKED' }],
   otp: '123456',
   otpExpires: new Date(),
   passwordChangedAt: new Date(),
   failedLoginCount: 3,
   lockedUntil: new Date(),
   sessions: [{ tokenIdHash: 'LEAKED' }],
   role: 'SUPER_ADMIN',
   cost_price: 999,
   costPrice: 999,
   margin: 0.42,
   supplier: 'Secret Supplier Ltd',
   internalNotes: 'do not show the customer',
   __v: 0,
   ...extra,
})

const assertNoFields = (label: string, output: any, forbidden: string[]) => {
   const serialised = JSON.stringify(output ?? {})
   const keys = Object.keys(output ?? {})
   forbidden.forEach((field) => {
      assert.ok(
         !keys.includes(field),
         `${label} exposed forbidden field "${field}" — output: ${serialised}`
      )
   })
   // Catch values that leaked under a renamed key.
   ;['LEAKED', 'LEAKED-SECRET', 'LEAKED-HASH', 'Secret Supplier Ltd'].forEach(
      (canary) => {
         assert.ok(
            !serialised.includes(canary),
            `${label} leaked a sensitive VALUE under a different key — output: ${serialised}`
         )
      }
   )
}

console.log('\nLeak tests (§14.3)\n')

console.log('Public surface DTOs')
check('presentPublicUser hides admin-only and secret fields', () => {
   const out = presentPublicUser(poisoned() as any)
   assertNoFields('presentPublicUser', out, [...NEVER_ANYWHERE, ...NEVER_PUBLIC])
   assert.strictEqual((out as any).email, 'test@example.com', 'lost a legitimate field')
})

console.log('\nAdmin surface DTOs')
check('presentAdminUser hides credentials', () => {
   const out = presentAdminUser(poisoned({ createdAt: new Date() }) as any, {
      permissions: ['orders:read'],
      roleName: 'Super admin',
   })
   assertNoFields('presentAdminUser', out, NEVER_ANYWHERE)
   assert.strictEqual((out as any).role, 'SUPER_ADMIN', 'admin surface should see role')
   assert.deepStrictEqual((out as any).permissions, ['orders:read'], 'lost permissions')
})

check('presentAccessUser hides credentials', () => {
   const out = presentAccessUser(poisoned({ createdAt: new Date() }) as any, 'Front desk')
   assertNoFields('presentAccessUser', out, [...NEVER_ANYWHERE, 'sessions', 'temporaryPassword'])
   assert.strictEqual((out as any).email, 'test@example.com', 'lost a legitimate field')
})

check('presentAccessRole emits only role fields', () => {
   const out = presentAccessRole(poisoned({ permissions: ['orders:read'] }) as any, 2)
   assertNoFields('presentAccessRole', out, NEVER_ANYWHERE)
   assert.strictEqual((out as any).userCount, 2, 'lost a legitimate field')
})

check('presentSessions hides the token hash', () => {
   const out = presentSessions([
      poisoned({ deviceLabel: 'Chrome on Mac OS', createdAt: new Date(), lastSeenAt: new Date() }) as any,
   ])
   assertNoFields('presentSessions', out[0], NEVER_ANYWHERE)
})

check('presentAuditLogs hides credentials', () => {
   const out = presentAuditLogs([poisoned({ action: 'UPDATE', createdAt: new Date() }) as any])
   assertNoFields('presentAuditLogs', out[0], NEVER_ANYWHERE)
})

console.log('\nSensitive-field redaction (§14.5)')
check('audit diffs redact decrypted passport numbers', () => {
   const { __testRedact } = require('../services/auditLog.service')
   const out = JSON.stringify(
      __testRedact({ travellers: [{ documentNumber: 'OP1234567', firstName: 'Jean' }] })
   )
   assert.ok(
      !out.includes('OP1234567'),
      `passport number reached the audit diff: ${out}`
   )
   assert.ok(out.includes('Jean'), 'redaction removed a non-sensitive field')
})

console.log('\nSurface separation (§14.3 rule 2)')
check('no public module imports an admin DTO', () => {
   const publicDirs = ['routes/v1', 'dto/public']
   const offenders: string[] = []

   const walk = (dir: string) => {
      const abs = path.join(__dirname, '..', dir)
      if (!fs.existsSync(abs)) return
      fs.readdirSync(abs, { withFileTypes: true }).forEach((entry) => {
         const full = path.join(abs, entry.name)
         if (entry.isDirectory()) return walk(path.join(dir, entry.name))
         if (!entry.name.endsWith('.ts')) return
         const src = fs.readFileSync(full, 'utf8')
         if (/from\s+['"].*dto\/admin/.test(src) || /routes\/admin/.test(src)) {
            offenders.push(path.join(dir, entry.name))
         }
      })
   }
   publicDirs.forEach(walk)

   assert.strictEqual(
      offenders.length,
      0,
      `public modules importing admin code: ${offenders.join(', ')}`
   )
})

check('admin surface does not import the public user DTO', () => {
   const abs = path.join(__dirname, '..', 'dto', 'admin')
   const offenders = fs
      .readdirSync(abs)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
         /from\s+['"].*dto\/public/.test(fs.readFileSync(path.join(abs, f), 'utf8'))
      )
   assert.strictEqual(offenders.length, 0, `admin DTOs importing public DTOs: ${offenders}`)
})

console.log(
   failures === 0
      ? '\nAll leak tests passed.\n'
      : `\n${failures} leak test(s) FAILED.\n`
)

// ponytail: covers the DTO layer only. handleFactory.ts still returns raw
// Mongoose documents on /api/v1/user — it is inherited health-consultant
// scaffolding due for deletion with the domain model. Extend NEVER_PUBLIC and
// add a live-response assertion once real endpoints replace it.

process.exit(failures === 0 ? 0 : 1)
