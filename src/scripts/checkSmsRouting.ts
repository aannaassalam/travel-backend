/**
 * Unit check for the push/SMS routing rule (no DB, no sends).
 * The owner's rule (2026-10-26): a customer is texted only for a new booking,
 * a completed one and their sign-in code; every other message reaches them by
 * push alone, and is logged SKIPPED when no app could be pushed. Push stays
 * first: no text follows a delivered push. Drivers and the safety alert keep
 * their SMS. Also: the office's e-mail escapes what customers type.
 *   npx ts-node src/scripts/checkSmsRouting.ts
 */
import assert from 'assert'
import { Types } from 'mongoose'
import { NOTIFICATION_EVENTS, NotificationLog, NotificationTemplate } from '../model/enquiryModel'
import { notify, smsAfterPush } from '../services/notifications/notify.service'
import { officeMail } from '../services/notifications/officeMail.service'
import * as pushService from '../services/notifications/push.service'
import * as smsService from '../services/notifications/sms.service'

const E = NOTIFICATION_EVENTS

// The rule: texted only when allowed, and only when no push got through.
assert.strictEqual(smsAfterPush(false, true), true, 'may be texted, no app: texted')
assert.strictEqual(smsAfterPush(true, true), false, 'pushed: no text after it')
assert.strictEqual(smsAfterPush(false, false), false, 'not to be texted: never, app or not')
assert.strictEqual(smsAfterPush(true, false), false)

const main = async () => {
   // notify() itself, the models and providers stubbed in place.
   const logs: any[] = []
   const texts: string[] = []
   let devices: { token: string }[] = []
   ;(NotificationTemplate as any).find = async () => [{ channel: 'SMS', body: 'Booking {{order_ref}}' }]
   ;(NotificationLog as any).create = async (row: any) => logs.push(row)
   ;(smsService as any).smsConfigured = () => true
   ;(smsService as any).sendSms = async (_to: string, body: string) => {
      texts.push(body)
      return { sid: 'SM1', status: 'queued' }
   }
   ;(pushService as any).pushConfigured = () => true
   ;(pushService as any).activeDevices = async () => devices
   const taps: string[] = []
   ;(pushService as any).sendPush = async (_tokens: string[], m: { data: { reference: string } }) => {
      taps.push(m.data.reference)
      return { delivered: devices.length }
   }
   const customer = new Types.ObjectId()
   const order = new Types.ObjectId()
   const send = (sms: boolean) =>
      notify({ event: E.ORDER_CONFIRMED, recipient: '+243810000042', customer, order, vars: { order_ref: 'FA-1' }, sms })

   assert.strictEqual(await send(true), 1, 'no app, may be texted: the SMS')
   assert.deepStrictEqual(texts.splice(0), ['Booking FA-1'])

   logs.length = 0
   assert.strictEqual(await send(false), 0, 'no app, not to be texted: nothing sent')
   assert.strictEqual(texts.length, 0)
   assert.deepStrictEqual(logs.map((l) => [l.channel, l.status, l.body]), [['SMS', 'SKIPPED', 'Booking FA-1']])
   assert.ok(logs[0].providerMessage.startsWith('Not texted'), 'the log says why nothing came')

   devices = [{ token: 'device-1' }]
   logs.length = 0
   assert.strictEqual(await send(true), 1, 'the app reached them: pushed')
   assert.strictEqual(texts.length, 0, 'and not texted as well')
   assert.deepStrictEqual(logs.map((l) => [l.channel, l.status]), [['PUSH', 'SENT']], 'nothing skipped')
   // A tap opens the order: an enquiry's DM- reference would open a 404 in the app.
   await notify({ event: E.QUOTE_SENT, recipient: '+243810000042', customer, vars: { order_ref: 'DM-1' }, sms: false })
   assert.deepStrictEqual(taps, ['FA-1', ''], 'only an order push opens a booking')

   devices = []
   assert.strictEqual(await notify({ event: E.DRIVER_WELCOME, recipient: '+243810000101' }), 1, 'a driver is texted')

   // The office's e-mail: what a customer typed is text, never markup.
   const mail = officeMail(
      'NEW',
      {
         reference: 'FA-1',
         items: [{ vertical: 'HOTEL', listingLabel: 'Memling <i>&</i>', quantity: 1 }],
         chargedTotal: 28_500,
         chargedCurrency: 'CDF',
         paymentMethod: 'CASH',
         paymentStatus: 'UNPAID',
         status: 'SUBMITTED',
         cashDeadline: new Date('2026-11-03T08:30:00.000Z'),
      },
      { firstName: '<b>Ann & "Co"</b>', phone: '+243810000042' }
   )
   assert.ok(mail.html.includes('&lt;b&gt;Ann &amp; &quot;Co&quot;&lt;/b&gt;'), mail.html)
   assert.ok(!mail.html.includes('<b>Ann') && !mail.html.includes('<i>&'), 'unescaped text in the HTML')
   assert.strictEqual(mail.subject, 'New booking FA-1 — Memling <i>&</i>', 'the subject is plain text')
   assert.ok(mail.text.includes('Customer name: <b>Ann & "Co"</b>'), 'the text part is as typed')
   assert.ok(mail.text.startsWith('A new booking was made, to be paid in cash at the office by 2026-11-03.'))

   console.log('checkSmsRouting: OK — customers texted only where allowed, push first, the rest logged SKIPPED; office e-mail escaped')
}

main().catch((err) => {
   console.error(err)
   process.exit(1)
})
