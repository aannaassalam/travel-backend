/**
 * Self-check for the pieces of the payment path where a bug is not a bug but an
 * incident: the amount conversion and the notification parser.
 *
 *   npm run check:payments
 *
 * No framework and no network — these are pure functions, and the point is that
 * it runs anywhere, including before a deploy.
 */
import assert from 'assert'

process.env.MAXICASH_MERCHANT_ID ||= 'test'
process.env.MAXICASH_MERCHANT_PASSWORD ||= 'test'

import { parseNotification, toProviderAmount } from '../services/payments/maxicash.service'

const refuses = (fn: () => unknown, why: string) => {
   try {
      fn()
   } catch {
      return
   }
   assert.fail(`should have been refused: ${why}`)
}

/* ------------------------------------------------------------- amounts */

/**
 * MaxiCash takes CENTS, which is exactly how money is stored here, so for USD
 * this is the identity function. The previous provider wanted whole dollars and
 * refused $176.13 outright; this asserts that case now goes through.
 */
assert.strictEqual(toProviderAmount(17600, 'USD'), 17600, '$176.00 -> 17600 cents')
assert.strictEqual(toProviderAmount(17613, 'USD'), 17613, '$176.13 must be payable')
assert.strictEqual(toProviderAmount(100, 'USD'), 100, '$1.00 -> 100 cents')

/**
 * The 100x guard. Our CDF is stored with NO decimals, so its minor units are
 * whole francs; sending them as cents would undercharge by 100x. MaxiCash does
 * not settle CDF, so the currency is refused rather than silently converted.
 */
refuses(() => toProviderAmount(325500, 'CDF'), 'CDF is not settled by MaxiCash')
refuses(() => toProviderAmount(5000, 'EUR'), 'EUR is not settled by MaxiCash')
refuses(() => toProviderAmount(0, 'USD'), 'zero is not payable')
refuses(() => toProviderAmount(-100, 'USD'), 'negative amounts')
refuses(() => toProviderAmount(1.5, 'USD'), 'fractional minor units')

/* -------------------------------------------------- notification parsing */

// Whatever shape it arrives in, and whatever the casing.
const a = parseNotification([{ Reference: 'FA-ABC', PmtID: '99', Status: 'Success' }])
assert.strictEqual(a.reference, 'FA-ABC')
assert.strictEqual(a.paymentId, '99')
assert.strictEqual(a.claimedStatus, 'Success')

const b = parseNotification([undefined, { reference: 'FA-XYZ', paymentid: '7' }])
assert.strictEqual(b.reference, 'FA-XYZ')
assert.strictEqual(b.paymentId, '7')

// Query string and body merged, as the route passes both.
const c = parseNotification([{ status: 'failed' }, { Reference: 'FA-Q' }])
assert.strictEqual(c.reference, 'FA-Q')
assert.strictEqual(c.claimedStatus, 'failed')

// Nothing usable must stay null rather than inventing a match.
const d = parseNotification([{ unrelated: 'x' }, undefined])
assert.strictEqual(d.reference, null)
assert.strictEqual(d.paymentId, null)

/**
 * The parser must never report "paid". Settlement comes from the status call,
 * and a field named like a verdict on this object would invite someone to
 * trust it.
 */
assert.ok(!('paid' in (a as object)), 'the notification parser must not decide payment')

console.log('payment maths and notification parsing OK')
