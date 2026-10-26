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
import { presentOrderList } from '../dto/admin/order.dto'
import { presentPublicUser } from '../dto/public/user.dto'
import { presentHotel, presentListing } from '../dto/public/catalogue.dto'
import { presentOrder } from '../dto/public/order.dto'
import { presentOwnReview, presentReviews } from '../dto/public/review.dto'
import { presentDriverRide, presentPublicCategory, presentPublicRide } from '../dto/public/transfer.dto'
import { authorNameOf } from '../services/reviews.service'

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

check('presentListing (bus route) hides every cost and the agency behind it', () => {
   const out = presentListing(
      poisoned({
         vertical: 'BUS',
         title: { fr: 'Kinshasa → Matadi' },
         slug: 'kin-mat',
         city: 'Kinshasa',
         images: [],
         // Whole francs, as every price is stored.
         sellPrice: { CDF: 42_800 },
         childSellPrice: { CDF: 28_500 },
         infantSellPrice: { CDF: 0 },
         childCostPrice: { CDF: 19_979 },
         infantCostPrice: { CDF: 1 },
         // A populated supplier: its contact details are the office's, not the customer's.
         supplier: { _id: 'x', name: 'Secret Supplier Ltd', phone: 'LEAKED', email: 'LEAKED' },
         attributes: { destination: 'Matadi', dailyTimes: ['06:30'], operator: 'Transco' },
      }) as any
   )
   assertNoFields('presentListing', out, [
      ...NEVER_ANYWHERE,
      ...NEVER_PUBLIC,
      'childCostPrice',
      'infantCostPrice',
   ])
   assert.ok(!JSON.stringify(out).includes('19979'), 'the child cost reached the public listing')
   assert.strictEqual((out as any).childPrice.CDF, 28_500, 'lost the child fare')
   assert.strictEqual((out as any).attributes.operator, 'Transco', 'lost the operator name')
})

check('presentListing (car) shows its rates and none of their costs', () => {
   const out = presentListing(
      poisoned({
         vertical: 'CAR',
         title: { fr: 'Toyota Prado' },
         slug: 'prado',
         city: 'Kinshasa',
         images: [],
         sellPrice: { CDF: 513_000 },
         // No hourly price: the rate is not offered, and its cost goes nowhere either.
         hourlySellPrice: { CDF: 0 },
         hourlyCostPrice: { CDF: 38_671 },
         sixHourSellPrice: { CDF: 171_000 },
         sixHourCostPrice: { CDF: 123_149 },
         twelveHourSellPrice: { CDF: 285_000 },
         twelveHourCostPrice: { CDF: 214_633 },
         attributes: { make: 'Toyota', model: 'Prado', transmission: 'AUTOMATIC' },
      }) as any
   )
   assertNoFields('presentListing', out, [
      ...NEVER_ANYWHERE,
      ...NEVER_PUBLIC,
      'hourlyCostPrice',
      'sixHourCostPrice',
      'twelveHourCostPrice',
   ])
   const json = JSON.stringify(out)
   ;['38671', '123149', '214633'].forEach((cost) =>
      assert.ok(!json.includes(cost), `a car rate's cost (${cost}) reached the public listing`)
   )
   const rates = (out as any).rentalRates
   assert.deepStrictEqual(rates.map((r: any) => r.hours), [6, 12, 24], 'wrong rates offered')
   assert.strictEqual(rates[0].price.CDF, 171_000, 'lost the 6-hour rate')
})

check('presentHotel hides room costs', () => {
   const out = presentHotel(
      poisoned({
         name: { fr: 'Hôtel' },
         slug: 'h',
         roomTypes: [
            poisoned({ hotel: 'h', name: { fr: 'Standard' }, sellPrice: { CDF: 256_500 }, costPrice: { CDF: 186_457 } }),
         ],
      }) as any
   )
   assertNoFields('presentHotel', out, [...NEVER_ANYWHERE, ...NEVER_PUBLIC])
   assert.ok(!JSON.stringify(out).includes('186457'), 'a room cost reached the public hotel')
   assert.strictEqual((out as any).roomTypes[0].sellPrice.CDF, 256_500, 'lost the room price')
})

check('presentOrder hides line costs, and gives the francs with what was charged', () => {
   const line = poisoned({
      vertical: 'CAR',
      listingLabel: 'Toyota Prado',
      quantity: 1,
      unitSellPrice: 513_000,
      unitCostPrice: 342_017,
      lineTotal: 513_000,
      lineCost: 342_017,
   })
   const out: any = presentOrder(
      poisoned({
         reference: 'FA-ABCDE-FGHIJ',
         status: 'SUBMITTED',
         baseCurrency: 'CDF',
         total: 513_000,
         chargedCurrency: 'USD',
         chargedTotal: 18_000,
         fxRate: 2850,
         items: [line],
      })
   )
   assertNoFields('presentOrder', out, [...NEVER_ANYWHERE, ...NEVER_PUBLIC])
   assertNoFields('presentOrder line', out.items[0], [...NEVER_ANYWHERE, ...NEVER_PUBLIC, 'unitCostPrice', 'lineCost'])
   assert.ok(!JSON.stringify(out).includes('342017'), 'a line cost reached the public order')
   assert.deepStrictEqual(out.total, { CDF: 513_000, USD: 18_000 }, 'lost the francs or the charge')
   assert.deepStrictEqual(out.items[0].lineTotal, { CDF: 513_000, USD: 18_000 })
   assert.deepStrictEqual(out.items[0].unitSellPrice, { CDF: 513_000 })
})

check('presentPublicCategory shows the fares and never what the office pays', () => {
   const out: any = presentPublicCategory(
      poisoned({ name: { fr: 'Berline' }, seats: 3, pricePerKm: { CDF: 1_800 }, costPerKm: { CDF: 1_100 }, costPerHour: { CDF: 15_000 } })
   )
   assertNoFields('presentPublicCategory', out, [...NEVER_ANYWHERE, ...NEVER_PUBLIC, 'costPerKm', 'costPerHour'])
   assert.ok(!JSON.stringify(out).includes('1100'), 'a cost per km reached the public category')
   assert.strictEqual(out.pricePerKm.CDF, 1_800, 'lost the fare')
})

/** A ride stuffed with everything the public and driver DTOs must drop. */
const poisonedRide = (status: string) =>
   poisoned({
      status,
      mode: 'DISTANCE',
      pickup: { label: 'Aéroport de Ndjili', lat: -4.3857, lng: 15.4446 },
      dropoff: { label: 'Hôtel Memling', lat: -4.3049, lng: 15.3151 },
      at: new Date('2026-11-03T08:30:00.000Z'),
      passengers: 2,
      categoryName: 'Berline',
      price: { CDF: 40_000 },
      cost: { CDF: 24_200 },
      customer: { _id: 'c0ffeec0ffeec0ffeec0ffee', email: 'leak@example.com' },
      customerName: 'Jean Test',
      customerPhone: '+243810000042',
      driver: poisoned({ name: 'Papy', phone: '+243810000101', licenceNumber: 'LEAKED-LICENCE', ratingStats: { rating: 4.5, count: 2 } }),
      vehicle: poisoned({ make: 'Toyota', model: 'Corolla', plate: 'KN 1234 AB' }),
      timeline: [{ at: new Date(), event: 'RIDE_ASSIGNED', actor: 'OFFICE', detail: 'internal note' }],
      alerts: [],
   })

check('presentPublicRide hides the driver until assigned, then only their public card', () => {
   const pending: any = presentPublicRide(poisonedRide('PENDING'))
   assertNoFields('presentPublicRide', pending, [...NEVER_ANYWHERE, ...NEVER_PUBLIC, 'cost', 'customer', 'customerPhone'])
   assert.strictEqual(pending.driver, undefined, 'a driver was shown before assignment')
   const assigned: any = presentPublicRide(poisonedRide('ASSIGNED'))
   assertNoFields('presentPublicRide driver', assigned.driver, [...NEVER_ANYWHERE, ...NEVER_PUBLIC, 'licenceNumber', '_id', 'id'])
   assert.strictEqual(assigned.driver.phone, '+243810000101', 'lost the driver phone once assigned')
   for (const out of [pending, assigned]) {
      const s = JSON.stringify(out)
      assert.ok(!s.includes('24200') && !s.includes('leak@example.com') && !s.includes('c0ffee'), `public ride leaked — ${s}`)
   }
})

check("presentDriverRide carries the customer's name and phone, never their account or the cost", () => {
   const out: any = presentDriverRide(poisonedRide('ASSIGNED'), poisoned({ paymentMethod: 'CASH', paymentStatus: 'UNPAID' }))
   assertNoFields('presentDriverRide', out, [...NEVER_ANYWHERE, ...NEVER_PUBLIC, 'cost', 'driver', 'customerName', 'customerPhone'])
   assertNoFields('presentDriverRide customer', out.customer, ['_id', 'id', 'email'])
   assert.deepStrictEqual(out.customer, { name: 'Jean Test', phone: '+243810000042' })
   const s = JSON.stringify(out)
   assert.ok(!s.includes('24200') && !s.includes('leak@example.com') && !s.includes('c0ffee') && !s.includes('internal note'), `driver ride leaked — ${s}`)
   assert.strictEqual(out.price.CDF, 40_000, 'lost the price the driver collects')
})

check('presentReviews never names the customer behind a review', () => {
   const customer = { _id: 'c0ffeec0ffeec0ffeec0ffee', phone: '+243810000042', email: 'leak@example.com' }
   const doc = poisoned({
      authorName: 'Patrick M.',
      rating: 4,
      comment: 'Chambre propre',
      verified: true,
      status: 'APPROVED',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      customer,
      phone: customer.phone,
      moderatedBy: 'LEAKED',
   }) as any
   const listed = presentReviews([doc])[0]
   const own = presentOwnReview(doc)
   const forbidden = [...NEVER_ANYWHERE, ...NEVER_PUBLIC, 'customer', 'phone', 'email', 'moderatedBy']
   assertNoFields('presentReviews', listed, [...forbidden, 'status'])
   assertNoFields('presentOwnReview', own, forbidden)
   ;[listed, own].forEach((out) => {
      const json = JSON.stringify(out)
      ;[customer._id, customer.phone, customer.email].forEach((v) =>
         assert.ok(!json.includes(v), `a customer detail (${v}) reached a public review`)
      )
   })
   assert.strictEqual((listed as any).authorName, 'Patrick M.', 'lost the author')
   assert.strictEqual((own as any).status, 'APPROVED', 'the customer lost their own review status')
   // What the author is signed as: the surname cut to its initial, everywhere.
   assert.strictEqual(authorNameOf(' Patrick ', 'mukendi'), 'Patrick M.')
   assert.strictEqual(authorNameOf('Élodie', 'Ékanga Lunda'), 'Élodie É.')
   assert.strictEqual(authorNameOf('Aline', ''), 'Aline')
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

check('presentOrderList leaks nothing and labels each total with the currency it is in', () => {
   const out = presentOrderList([
      // Still US cents (migrate:cdf not run); converted to francs, keeping the
      // 'USD' it was made in as `currency`; made since prices are francs.
      poisoned({ currency: 'USD', total: 36_000 }),
      poisoned({ currency: 'USD', baseCurrency: 'CDF', total: 1_026_000 }),
      poisoned({ currency: 'CDF', baseCurrency: 'CDF', total: 1_026_000 }),
   ] as any)
   out.forEach((o: any) => assertNoFields('presentOrderList', o, NEVER_ANYWHERE))
   assert.deepStrictEqual(out.map((o: any) => o.currency), ['USD', 'CDF', 'CDF'], 'a total labelled in the wrong currency')
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
