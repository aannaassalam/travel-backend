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

import {
   amountCovers,
   isToken,
   maxicashEnabled,
   newToken,
   parseNotification,
   paymentAwaited,
   paymentsStatus,
   toProviderAmount,
   tokenHash,
} from '../services/payments/maxicash.service'

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
assert.strictEqual(toProviderAmount(500, 'USD'), 500, '$5.00, the least MaxiCash takes -> 500 cents')
refuses(() => toProviderAmount(499, 'USD'), 'under five dollars: MaxiCash turns it away on its own page')
refuses(() => toProviderAmount(100, 'USD'), 'one dollar is under the minimum')

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
const a = parseNotification([{ Reference: 'FA-ABC', PmtID: '99', Status: 'Success', Amount: '17613' }])
assert.strictEqual(a.reference, 'FA-ABC')
assert.strictEqual(a.paymentId, '99')
assert.strictEqual(a.claimedStatus, 'Success')
assert.strictEqual(a.amount, '17613')
assert.strictEqual(a.outcome, 'PAID', '"Success" is the one word that means paid')

const b = parseNotification([undefined, { reference: 'FA-XYZ', paymentid: '7' }])
assert.strictEqual(b.reference, 'FA-XYZ')
assert.strictEqual(b.paymentId, '7')
assert.strictEqual(b.outcome, 'PENDING', 'no status word is not a payment')

// Query string and body merged, as the route passes both.
const c = parseNotification([{ status: 'failed' }, { Reference: 'FA-Q' }])
assert.strictEqual(c.reference, 'FA-Q')
assert.strictEqual(c.claimedStatus, 'failed')
assert.strictEqual(c.outcome, 'FAILED')

// Nothing usable must stay null rather than inventing a match.
const d = parseNotification([{ unrelated: 'x' }, undefined])
assert.strictEqual(d.reference, null)
assert.strictEqual(d.paymentId, null)
assert.strictEqual(d.outcome, 'PENDING')

/**
 * Fail closed: a word this server does not know is never "paid" — not a
 * near-miss ("successfully declined"), not a number, not an object.
 */
for (const word of ['', 'ok', '1', 'true', 'pending', 'successfully declined', 'not success', 'SUCCESS ']) {
   const outcome = parseNotification([{ status: word }]).outcome
   assert.ok(
      word.trim().toLowerCase() === 'success' ? outcome === 'PAID' : outcome === 'PENDING',
      `status "${word}" was taken as ${outcome}`
   )
}
assert.strictEqual(parseNotification([{ status: { toString: () => 'success' } }]).outcome, 'PENDING')
assert.strictEqual(parseNotification([{ status: ['success'] }]).outcome, 'PENDING')

/**
 * The names MaxiCash's own notifying operation carries (Reference, Status,
 * Method, MaxiCashTransactionID, Amount, Fee), and the ones its page puts on
 * the address it sends a customer back to (status, reference, Method).
 */
{
   const n = parseNotification([
      { Reference: 'FA-1', Status: 'success', Method: 'MPESA', MaxiCashTransactionID: '778899', Amount: '91500', Fee: '3202' },
   ])
   assert.deepStrictEqual(
      [n.outcome, n.reference, n.method, n.paymentId, n.amount],
      ['PAID', 'FA-1', 'MPESA', '778899', '91500']
   )
   const back = parseNotification([{ status: 'failed', reference: 'FA-1', Method: '' }])
   assert.deepStrictEqual([back.outcome, back.reference, back.method], ['FAILED', 'FA-1', null])
}

/* ------------------------------------------------------------ addresses */

/**
 * What proves a call is MaxiCash's is the address: 256 random bits, of which
 * only the hash is stored. Anything that is not one of ours is not looked up.
 */
const t1 = newToken()
const t2 = newToken()
assert.ok(/^[0-9a-f]{64}$/.test(t1) && t1 !== t2, 'tokens are 64 hex characters and never repeat')
assert.ok(isToken(t1) && !isToken(t1.slice(1)) && !isToken(t1.toUpperCase()) && !isToken({ $ne: null }))
assert.ok(tokenHash(t1) !== t1 && tokenHash(t1) === tokenHash(t1) && tokenHash(t1) !== tokenHash(t2))

/* ------------------------------------------------- the amount it reports */

/**
 * A 915.00 order (91500 in our units). MaxiCash may report the amount in cents
 * or in whole units, and its page adds its fee (947.02 was charged for this
 * one). Those are this payment. Less than the order, or wildly more, is not.
 */
// (and the small order MaxiCash's dollar-minimum fee weighs most on: 5.00 charged 6.00; 23.45 charged 24.45)
assert.ok(amountCovers(500, '600') && amountCovers(500, '6.00') && amountCovers(2345, '24.45') && amountCovers(2345, '2445'))
assert.ok(!amountCovers(500, '700') && !amountCovers(500, '499') && !amountCovers(500, '4.99'))
for (const said of ['91500', '915', '915.00', '94702', '947.02']) {
   assert.ok(amountCovers(91500, said), `${said} should cover a 915.00 order`)
}
for (const said of ['1', '100', '91499', '914.99', '9150', '200000', '2000', '0', '-915', 'abc', '915,00']) {
   assert.ok(!amountCovers(91500, said), `${said} must not cover a 915.00 order`)
}
assert.ok(amountCovers(91500, null), 'an amount that is not sent is nothing to disagree with')
// a small order: its amount in units must not pass for another in cents
assert.ok(amountCovers(2345, '2345') && amountCovers(2345, '23.45') && !amountCovers(2345, '23') && !amountCovers(2345, '1'))

/* ------------------------------------------------- "may already be paid" */

/**
 * When a second payment must not be opened: the order is pending AND the
 * customer came back by the "paid" address, or MaxiCash sent a notice that
 * could not be read. Not merely pending (the page may never have been used),
 * and never once the order has left "pending".
 */
assert.ok(!paymentAwaited({ paymentStatus: 'PENDING', payment: {} }))
assert.ok(!paymentAwaited({ paymentStatus: 'PENDING', payment: { returnOutcome: 'FAILURE' } }))
assert.ok(paymentAwaited({ paymentStatus: 'PENDING', payment: { returnOutcome: 'SUCCESS' } }))
assert.ok(paymentAwaited({ paymentStatus: 'PENDING', payment: { lastNotification: { at: new Date() } } }))
for (const settled of ['PAID', 'FAILED', 'UNPAID', 'REVERSED']) {
   assert.ok(
      !paymentAwaited({ paymentStatus: settled, payment: { returnOutcome: 'SUCCESS', lastNotification: {} } }),
      `${settled} is not "awaited"`
   )
}
assert.ok(!paymentAwaited({ paymentStatus: 'PENDING' }) && !paymentAwaited({ paymentStatus: 'PENDING', payment: null }))

/* ----------------------------------------------------------- configuration */

/**
 * Online payment is offered only when it can work: the switch, the merchant
 * pair and both addresses — and, for real money, addresses MaxiCash and a
 * customer's browser can actually reach. The start-up line says which of
 * these is missing, and never a credential.
 */
{
   const kept = { ...process.env }
   const withEnv = (patch: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(patch)) {
         if (v === undefined) delete process.env[k]
         else process.env[k] = v
      }
   }
   withEnv({
      ONLINE_PAYMENTS_ENABLED: 'true',
      MAXICASH_MERCHANT_ID: 'zz-id',
      MAXICASH_MERCHANT_PASSWORD: 'zz-very-secret',
      MAXICASH_ENV: 'sandbox',
      API_PUBLIC_URL: 'http://localhost:3001',
      FRONTEND_URL: 'http://localhost:3000',
      PUBLIC_SITE_URL: undefined,
   })
   assert.ok(maxicashEnabled(), 'the sandbox may be used from a developer machine')
   assert.ok(/ON through MaxiCash sandbox/.test(paymentsStatus()), paymentsStatus())

   withEnv({ MAXICASH_ENV: 'live' })
   assert.ok(!maxicashEnabled(), 'live with local addresses must not be offered')
   assert.ok(/NOT OFFERED/.test(paymentsStatus()) && /public https/.test(paymentsStatus()), paymentsStatus())
   withEnv({ API_PUBLIC_URL: 'https://backend.example.com', FRONTEND_URL: 'http://example.com' })
   assert.ok(!maxicashEnabled(), 'live needs https for the website too')
   withEnv({ FRONTEND_URL: 'https://example.com/' })
   assert.ok(maxicashEnabled())
   assert.ok(/ON through MaxiCash LIVE/.test(paymentsStatus()), paymentsStatus())

   withEnv({ MAXICASH_MERCHANT_PASSWORD: undefined })
   assert.ok(!maxicashEnabled())
   assert.ok(/not set: MAXICASH_MERCHANT_PASSWORD/.test(paymentsStatus()), paymentsStatus())
   withEnv({ MAXICASH_MERCHANT_PASSWORD: 'zz-very-secret', ONLINE_PAYMENTS_ENABLED: 'TRUE' })
   assert.ok(/OFF, cash only/.test(paymentsStatus()), 'the switch is exactly "true"')

   for (const patch of [{}, { ONLINE_PAYMENTS_ENABLED: 'true' }, { MAXICASH_ENV: 'sandbox' }]) {
      withEnv(patch)
      assert.ok(!/zz-very-secret|zz-id/.test(paymentsStatus()), 'the start-up line never carries a credential')
   }
   for (const k of Object.keys(process.env)) if (!(k in kept)) delete process.env[k]
   Object.assign(process.env, kept)
}

console.log('payment maths, notification parsing, address tokens, the "awaited" rule and configuration OK')
