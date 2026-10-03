/**
 * Unit check for the push/SMS routing rule (no DB, no sends).
 * §2026-10-03 policy: cash-deadline reminders are push-first (SMS only as a
 * fallback); only order cancellations still SMS even when push delivered.
 *   npx ts-node src/scripts/checkSmsRouting.ts
 */
import assert from 'assert'
import { NOTIFICATION_EVENTS } from '../model/enquiryModel'
import { smsAfterPush } from '../services/notifications/notify.service'

const E = NOTIFICATION_EVENTS

// Cash reminders: push-first now — no SMS when push reached the device...
assert.strictEqual(smsAfterPush(E.CASH_DEADLINE_REMINDER, true), false, 'cash reminder must NOT SMS when push delivered')
// ...but still fall back to SMS when push could not be delivered.
assert.strictEqual(smsAfterPush(E.CASH_DEADLINE_REMINDER, false), true, 'cash reminder must SMS when push failed')

// Cancellations must reach the customer regardless of the app.
assert.strictEqual(smsAfterPush(E.ORDER_CANCELLED, true), true, 'cancellation stays SMS-always')
assert.strictEqual(smsAfterPush(E.ORDER_CANCELLED, false), true)

// Ordinary events: push-only when the push delivered, SMS only as fallback.
assert.strictEqual(smsAfterPush(E.ORDER_CONFIRMED, true), false, 'confirmed must be push-only when delivered')
assert.strictEqual(smsAfterPush(E.ORDER_CONFIRMED, false), true)

console.log('checkSmsRouting: OK — cash reminders are push-first; only cancellations are SMS-always')
