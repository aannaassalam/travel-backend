/**
 * Self-check for the transfers module — the rules that are pure enough to prove
 * without a database or a network.
 *
 *   npm run check:transfers
 *
 * Covers: the fare (francs, up to the next 100 FC), the straight-line estimate
 * a quote falls back to when the routing service is down, the hour either
 * side of a ride that keeps a driver busy, the booking-time rules judged in
 * Kinshasa time, the alert window, the text to a driver a ride is taken off,
 * the default templates a boot adds, and what each DTO must never carry.
 * No framework: ts-node and assert, like the other check:* scripts.
 */
import assert from 'assert'
import { Types } from 'mongoose'

import { presentRideDetail } from '../dto/admin/transfer.dto'
import { presentDriverRide, presentPublicCategory, presentPublicRide } from '../dto/public/transfer.dto'
import { alertWindowOpen, Ride } from '../model/rideModel'
import { kinshasaToday, scopeFilter } from '../controllers/public/driverController'
import { BUFFER_MS, conflicts, rideWindow } from '../services/transfers/availability'
import { insideDrc } from '../services/transfers/geocoding.service'
import { offersMode, quoteFare, roundUp100 } from '../services/transfers/pricing'
import { parseQuoteRequest, parseRideTime, rideLabel } from '../services/transfers/quote.service'
import { verifyPassword } from '../middleware/customerAuth'
import { NOTIFICATION_TEMPLATE_DEFAULTS } from '../constants/notificationTemplates.defaults'
import AuditLog from '../model/auditLogModel'
import { Driver } from '../model/driverModel'
import { NOTIFICATION_EVENTS, NotificationLog, NotificationTemplate, TEMPLATE_VARIABLES } from '../model/enquiryModel'
import * as settingsModel from '../model/settingsModel'
import * as pushService from '../services/notifications/push.service'
import * as smsService from '../services/notifications/sms.service'
import { ensureDefaultTemplates } from '../services/scheduledJobs.service'
import {
   alertPhone,
   assignRefusal,
   assignRide,
   cancelRide,
   cancelRideOfOrder,
   mapsLink,
   raiseAlert,
   unassignRide,
} from '../services/transfers/rideLifecycle'
import { distanceBetween, estimate, haversineKm, sampleRoute } from '../services/transfers/routing.service'
import { cashDeadlineFor, TRANSFER_CASH_GRACE_MS } from '../services/orders/pricing.service'

let failures = 0
const check = async (name: string, fn: () => void | Promise<void>) => {
   try {
      await fn()
      console.log(`  ✓ ${name}`)
   } catch (err: any) {
      failures += 1
      console.error(`  ✗ ${name}\n      ${err.message}`)
   }
}

const refused = (fn: () => unknown) => {
   try {
      fn()
      return null
   } catch (e: any) {
      return e.code ?? e.message
   }
}

const NDJILI = { label: 'Aéroport de Ndjili', lat: -4.3857, lng: 15.4446 }
const MEMLING = { label: 'Hôtel Memling', lat: -4.3049, lng: 15.3151 }
const berline = {
   pricePerKm: { CDF: 1_800 },
   pricePerHour: { CDF: 25_000 },
   minimumFare: { CDF: 15_000 },
   costPerKm: { CDF: 1_100 },
   costPerHour: { CDF: 15_000 },
}

const main = async () => {
   console.log('\nTransfers self-check\n')

   console.log('Fare (francs, up to the next 100 FC)')
   await check('rounds up, never down, and leaves a round hundred alone', () => {
      assert.strictEqual(roundUp100(22_140), 22_200)
      assert.strictEqual(roundUp100(22_200), 22_200)
      assert.strictEqual(roundUp100(1), 100)
      assert.strictEqual(roundUp100(1_800 * 12.3), 22_200) // float noise does not add a hundred
   })
   await check('a journey is per km above the minimum; the hours are per hour; the cost has no minimum', () => {
      assert.deepStrictEqual(quoteFare(berline, { mode: 'DISTANCE', km: 12.3 }), { price: 22_200, cost: 13_600 })
      assert.deepStrictEqual(quoteFare(berline, { mode: 'DISTANCE', km: 2 }), { price: 15_000, cost: 2_200 })
      assert.deepStrictEqual(quoteFare(berline, { mode: 'HOURLY', hours: 3 }), { price: 75_000, cost: 45_000 })
   })
   await check('a mode the category has no price for is refused, not priced at zero', () => {
      assert.strictEqual(refused(() => quoteFare({ pricePerKm: { CDF: 1_800 } }, { mode: 'HOURLY', hours: 2 })), 'MODE_NOT_PRICED')
      assert.strictEqual(refused(() => quoteFare(berline, { mode: 'HOURLY', hours: 13 })), 'INVALID_HOURS')
      assert.ok(!offersMode({ pricePerKm: { CDF: 1_800 } }, 'HOURLY'))
   })

   console.log('\nDistance')
   await check('haversine: Ndjili to the Memling is about 17 km as the crow flies', () => {
      const km = haversineKm(NDJILI, MEMLING)
      assert.ok(km > 16 && km < 18, `got ${km}`)
   })
   await check('the estimate stretches the straight line by the detour factor at 30 km/h, as a two-point route', () => {
      const e = estimate(NDJILI, MEMLING, 1.3)
      assert.strictEqual(e.source, 'ESTIMATE')
      assert.ok(e.km > 21 && e.km < 23.5, `km ${e.km}`)
      assert.strictEqual(e.minutes, Math.round((e.km / 30) * 60))
      assert.deepStrictEqual(e.route, [[NDJILI.lng, NDJILI.lat], [MEMLING.lng, MEMLING.lat]])
      assert.strictEqual(Number(e.km.toFixed(1)), e.km, 'one decimal')
   })
   await check('distanceBetween falls back to the estimate when the routing service is unreachable, and caches it', async () => {
      process.env.ROUTING_URL = 'http://127.0.0.1:9' // nothing listens on the discard port
      process.env.ROUTING_TIMEOUT_MS = '500'
      const warn = console.warn
      console.warn = () => undefined
      try {
         const d = await distanceBetween(NDJILI, MEMLING, 1.3)
         assert.strictEqual(d.source, 'ESTIMATE')
         assert.strictEqual(d.km, estimate(NDJILI, MEMLING, 1.3).km)
         assert.strictEqual(await distanceBetween(NDJILI, MEMLING, 1.3), d, 'the second ask is the cached answer')
      } finally {
         console.warn = warn
      }
   })
   await check('a drawn route is thinned to 500 points, first and last kept', () => {
      const long = Array.from({ length: 2_000 }, (_, i) => [i, i])
      const out = sampleRoute(long)
      assert.strictEqual(out.length, 500)
      assert.deepStrictEqual(out[0], [0, 0])
      assert.deepStrictEqual(out[499], [1_999, 1_999])
      assert.strictEqual(sampleRoute(long.slice(0, 10)).length, 10)
   })
   await check('the DRC bounding box', () => {
      assert.ok(insideDrc(NDJILI))
      assert.ok(!insideDrc({ lat: 48.85, lng: 2.35 }), 'Paris is not in the DRC')
   })

   console.log('\nAvailability (an hour either side of a held ride)')
   await check('the window of a held ride', () => {
      const at = new Date('2026-11-03T10:00:00.000Z')
      const w = rideWindow({ at, durationMinutes: 30 })
      assert.strictEqual(w.start, at.getTime() - BUFFER_MS)
      assert.strictEqual(w.end, at.getTime() + 30 * 60_000 + BUFFER_MS)
   })
   await check('a ride at 10:00 for 30 min blocks 09:00–11:30 and nothing outside it', () => {
      const held = { at: new Date('2026-11-03T10:00:00.000Z'), durationMinutes: 30 }
      const at = (hhmm: string) => new Date(`2026-11-03T${hhmm}:00.000Z`)
      assert.ok(conflicts(held, at('11:00'), 30), '11:00 is inside the window')
      assert.ok(conflicts(held, at('08:45'), 30), '08:45–09:15 reaches into it')
      assert.ok(!conflicts(held, at('08:00'), 30), '08:00–08:30 ends before it')
      assert.ok(!conflicts(held, at('11:30'), 30), '11:30 starts as it ends')
      assert.ok(!conflicts(held, at('12:00'), 60), 'noon is clear')
   })

   console.log('\nBooking time (wall-clock, judged in Kinshasa)')
   await check('at least 30 minutes ahead, at most 90 days, a real date; stored as written', () => {
      // 06:00 UTC is 07:00 in Kinshasa.
      const now = Date.parse('2026-11-03T06:00:00.000Z')
      assert.strictEqual(parseRideTime('2026-11-03T08:30', now).toISOString(), '2026-11-03T08:30:00.000Z')
      assert.strictEqual(parseRideTime('2026-11-03T07:30:00', now).toISOString(), '2026-11-03T07:30:00.000Z')
      assert.strictEqual(refused(() => parseRideTime('2026-11-03T07:20', now)), 'INVALID_TIME', '20 minutes is too soon')
      assert.strictEqual(refused(() => parseRideTime('2027-02-03T08:30', now)), 'INVALID_TIME', '92 days is too far')
      assert.strictEqual(refused(() => parseRideTime('2026-02-31T08:30', now)), 'INVALID_TIME', 'no 31 February')
      assert.strictEqual(refused(() => parseRideTime('tomorrow', now)), 'INVALID_TIME')
   })
   await check('the quote request: points in the DRC, apart, with hours only by the hour', () => {
      const now = Date.parse('2026-11-03T06:00:00.000Z')
      const base = { city: 'Kinshasa', mode: 'DISTANCE', pickup: NDJILI, dropoff: MEMLING, at: '2026-11-03T09:00', passengers: 2 }
      const q = parseQuoteRequest(base, now)
      assert.strictEqual(q.mode, 'DISTANCE')
      assert.strictEqual(q.dropoff?.label, 'Hôtel Memling')
      assert.strictEqual(refused(() => parseQuoteRequest({ ...base, dropoff: { label: 'Paris', lat: 48.85, lng: 2.35 } }, now)), 'INVALID_POINT')
      assert.strictEqual(refused(() => parseQuoteRequest({ ...base, dropoff: { ...NDJILI, lat: NDJILI.lat + 0.0002 } }, now)), 'SAME_POINTS')
      assert.strictEqual(refused(() => parseQuoteRequest({ ...base, dropoff: undefined }, now)), 'POINT_REQUIRED')
      assert.strictEqual(refused(() => parseQuoteRequest({ ...base, passengers: 0 }, now)), 'INVALID_PASSENGERS')
      const hourly = parseQuoteRequest({ ...base, mode: 'HOURLY', dropoff: undefined, hours: 3 }, now)
      assert.strictEqual(hourly.hours, 3)
      assert.strictEqual(hourly.dropoff, undefined)
      assert.strictEqual(refused(() => parseQuoteRequest({ ...base, mode: 'HOURLY', hours: 13 }, now)), 'INVALID_HOURS')
      assert.strictEqual(rideLabel(q), 'Transfert · Aéroport de Ndjili → Hôtel Memling')
      assert.strictEqual(rideLabel(hourly), "Transfert à l'heure · Aéroport de Ndjili · 3 h")
   })
   await check("the driver's 'today' is Kinshasa's day", () => {
      assert.strictEqual(kinshasaToday(Date.UTC(2026, 10, 3, 23, 30)), '2026-11-04')
      assert.strictEqual(kinshasaToday(Date.UTC(2026, 10, 3, 22, 30)), '2026-11-03')
      const f: any = scopeFilter('d1', 'today', Date.UTC(2026, 10, 3, 12))
      assert.strictEqual(f.$or[1].at.$lt.toISOString(), '2026-11-04T00:00:00.000Z')
      // No lower bound: an assigned ride that is overdue (last night's late flight) stays in "today".
      assert.strictEqual(f.$or[1].at.$gte, undefined)
      const up: any = scopeFilter('d1', 'upcoming', Date.UTC(2026, 10, 3, 12))
      assert.strictEqual(up.at.$gte.toISOString(), '2026-11-04T00:00:00.000Z', 'upcoming starts where today ends')
   })

   console.log('\nAssignment (fit, not time: the busy check is availability\'s)')
   await check('a driver or car of another city, or a car too small for the party, is refused with its code', () => {
      const ride = { city: 'Kinshasa', passengers: 4 }
      const papy = { name: 'Papy', city: 'kinshasa ' } // as typed: case and spaces are not another city
      const corolla = { plate: 'KN 1234 AB', city: 'Kinshasa', seats: undefined }
      assert.strictEqual(assignRefusal(ride, papy, corolla, 5), null)
      assert.strictEqual(assignRefusal(ride, { ...papy, city: 'Lubumbashi' }, corolla, 5)?.code, 'DRIVER_OTHER_CITY')
      assert.strictEqual(assignRefusal(ride, papy, { ...corolla, city: 'Goma' }, 5)?.code, 'VEHICLE_OTHER_CITY')
      assert.strictEqual(assignRefusal(ride, papy, corolla, 3)?.code, 'VEHICLE_TOO_SMALL', "the category's seats")
      assert.strictEqual(assignRefusal(ride, papy, { ...corolla, seats: 3 }, 14)?.code, 'VEHICLE_TOO_SMALL', "the car's own seats win")
      assert.strictEqual(assignRefusal(ride, papy, { ...corolla, seats: 4 }, 3), null, 'four seats take four')
      assert.strictEqual(assignRefusal(ride, papy, corolla, undefined), null, 'no seat count known: not refused')
      assert.strictEqual(assignRefusal(ride, { ...papy, city: 'Lubumbashi' }, corolla, 5)?.statusCode, 409)
   })

   console.log('\nCash deadline')
   await check("a ride's cash is the driver's: the deadline is a day past the pick-up, never the office's hold", () => {
      const now = Date.parse('2026-11-03T06:00:00.000Z')
      const at = new Date('2026-11-05T08:30:00.000Z')
      const ride = [{ vertical: 'TRANSFER', startDate: at }]
      assert.strictEqual(cashDeadlineFor(ride, 48, now).toISOString(), '2026-11-06T08:30:00.000Z')
      assert.ok(cashDeadlineFor(ride, 48, now).getTime() > at.getTime(), 'never before the ride')
      assert.strictEqual(TRANSFER_CASH_GRACE_MS, 24 * 3600_000)
      // Everything else keeps the office's hold from now.
      assert.strictEqual(cashDeadlineFor([{ vertical: 'HOTEL', startDate: at }], 48, now).toISOString(), '2026-11-05T06:00:00.000Z')
      assert.strictEqual(cashDeadlineFor([], 48, now).toISOString(), '2026-11-05T06:00:00.000Z')
      // The ride stored on an order, its time as text: the same answer.
      assert.strictEqual(cashDeadlineFor([{ vertical: 'TRANSFER', startDate: at.toISOString() }], 48, now).toISOString(), '2026-11-06T08:30:00.000Z')
   })

   console.log('\nSecurity alert')
   await check('the window: from assignment until two hours after the ride', () => {
      const now = Date.now()
      assert.ok(alertWindowOpen({ status: 'ASSIGNED' }, now))
      assert.ok(alertWindowOpen({ status: 'STARTED' }, now))
      assert.ok(alertWindowOpen({ status: 'COMPLETED', endedAt: new Date(now - 3_600_000) }, now))
      assert.ok(!alertWindowOpen({ status: 'COMPLETED', endedAt: new Date(now - 3 * 3_600_000) }, now))
      assert.ok(!alertWindowOpen({ status: 'PENDING' }, now))
      assert.ok(!alertWindowOpen({ status: 'CANCELLED' }, now))
   })
   await check('where it goes: the alert phone, else the primary office, else support', () => {
      const offices: any = [{ phone: '+243810000001' }, { phone: '+243810000002', isPrimary: true }]
      assert.strictEqual(alertPhone({ transferAlertPhone: '+243999', offices, supportPhone: '+243000' } as any), '+243999')
      assert.strictEqual(alertPhone({ transferAlertPhone: '', offices, supportPhone: '+243000' } as any), '+243810000002')
      assert.strictEqual(alertPhone({ transferAlertPhone: '', offices: [], supportPhone: '+243000' } as any), '+243000')
      assert.strictEqual(mapsLink({ lat: -4.3, lng: 15.3 }), 'https://maps.google.com/?q=-4.3,15.3')
      assert.strictEqual(mapsLink(null), 'non partagée')
   })
   await check('a template written for push only does not silence it: the default text goes by SMS, once', async () => {
      // The models and the provider stubbed in place: no database, no Twilio.
      const texts: string[] = []
      let active: { channel: string }[] = [{ channel: 'PUSH' }]
      const matching = (f: any) => active.filter((t) => !f.channel || t.channel === f.channel)
      ;(NotificationTemplate as any).exists = async (f: any) => (matching(f).length ? { _id: 't' } : null)
      ;(NotificationTemplate as any).find = async (f: any) => matching(f).map((t) => ({ ...t, body: 'Alerte {{order_ref}}' }))
      ;(NotificationLog as any).create = async () => undefined
      ;(settingsModel as any).getSettings = async () => ({ transferAlertPhone: '+243999000000', offices: [], supportPhone: '' })
      ;(smsService as any).smsConfigured = () => true
      ;(smsService as any).sendSms = async (_to: string, body: string) => {
         texts.push(body)
         return { sid: 'SM1', status: 'queued' }
      }
      const fake = (): any => ({
         reference: 'FA-TEST',
         status: 'ASSIGNED',
         mode: 'DISTANCE',
         pickup: NDJILI,
         dropoff: MEMLING,
         at: new Date('2026-11-03T08:30:00.000Z'),
         customerName: 'Jean',
         customerPhone: '+243810000042',
         driver: { name: 'Papy', phone: '+243810000101' },
         vehicle: { make: 'Toyota', model: 'Corolla', plate: 'KN 1234 AB' },
         alerts: [],
         timeline: [],
         populated: () => true,
         populate: async () => undefined,
         save: async () => undefined,
      })
      assert.strictEqual((await raiseAlert(fake(), 'DRIVER', null, '')).sent, true)
      assert.strictEqual(texts.length, 1, 'push-only template: the built-in text, once')
      assert.ok(texts[0].startsWith('ALERTE SÉCURITÉ course FA-TEST par le chauffeur. Chauffeur Papy +243810000101'), texts[0])
      active = [{ channel: 'SMS' }]
      assert.strictEqual((await raiseAlert(fake(), 'CUSTOMER', { lat: -4.3, lng: 15.3 }, '')).sent, true)
      assert.deepStrictEqual(texts.slice(1), ['Alerte FA-TEST'], 'SMS template: the template, once')
   })

   console.log('\nA driver a ride is taken off')
   await check('is texted once on cancel, unassign or hand-over to another driver — never by push, never otherwise', async () => {
      // The models and the providers stubbed in place: no database, no Twilio, no Firebase.
      const papy = { _id: new Types.ObjectId(), name: 'Papy', phone: '+243810000101' }
      const gloire = { _id: new Types.ObjectId(), name: 'Gloire', phone: '+243810000102' }
      const people = new Map([papy, gloire].map((d) => [String(d._id), d]))
      ;(Driver as any).findById = (id: unknown) => ({ select: async () => people.get(String(id)) ?? null })
      const texts: string[] = []
      let pushes = 0
      ;(NotificationTemplate as any).find = async (f: any) => [
         { channel: 'PUSH', body: 'push {{order_ref}}' },
         { channel: 'SMS', body: `${f.event} {{order_ref}} {{departure_date}} {{pickup}}` },
      ]
      ;(NotificationLog as any).create = async () => undefined
      ;(smsService as any).smsConfigured = () => true
      ;(smsService as any).sendSms = async (to: string, body: string) => {
         texts.push(`${to} ${body}`)
         return { sid: 'SM1', status: 'queued' }
      }
      ;(pushService as any).pushConfigured = () => true
      ;(pushService as any).activeDevices = async () => [{ token: 'device-1' }]
      ;(pushService as any).sendPush = async () => {
         pushes += 1
         return { delivered: 1 }
      }
      const ride = (status: string, driver?: { _id: Types.ObjectId }): any => ({
         reference: 'FA-TEST',
         status,
         driver: driver?._id,
         mode: 'DISTANCE',
         pickup: NDJILI,
         dropoff: MEMLING,
         at: new Date('2026-11-03T08:30:00.000Z'),
         timeline: [],
         save: async () => undefined,
      })
      const car: any = { _id: new Types.ObjectId(), plate: 'KN 1234 AB' }
      // The lifecycle does not wait for its texts: let them land, then take them.
      const removals = async () => {
         await new Promise((r) => setTimeout(r, 20))
         return texts.splice(0).filter((t) => t.includes(NOTIFICATION_EVENTS.DRIVER_RIDE_REMOVED))
      }
      const toPapy = `${papy.phone} DRIVER_RIDE_REMOVED FA-TEST 2026-11-03 08:30 ${NDJILI.label}`

      await cancelRide(ride('ASSIGNED', papy), 'CUSTOMER_REQUEST', 'OFFICE')
      assert.deepStrictEqual(await removals(), [toPapy], 'cancelled while assigned')
      await unassignRide(ride('ASSIGNED', papy))
      assert.deepStrictEqual(await removals(), [toPapy], 'unassigned')
      await assignRide(ride('ASSIGNED', papy), gloire as any, car)
      assert.deepStrictEqual(await removals(), [toPapy], 'given to Gloire: Papy is told, once')
      // The order cancelled from Bookings, or by the cash-deadline job: the same text.
      ;(Ride as any).findOne = async () => ride('ASSIGNED', papy)
      await cancelRideOfOrder(new Types.ObjectId(), 'CASH_DEADLINE_EXPIRED', 'SYSTEM', 'Booking not paid in time')
      assert.deepStrictEqual(await removals(), [toPapy], 'cancelled with its order')

      await assignRide(ride('ASSIGNED', papy), papy as any, car)
      assert.deepStrictEqual(await removals(), [], 'the same driver again (another car): nothing was taken off him')
      await assignRide(ride('PENDING'), papy as any, car)
      await cancelRide(ride('PENDING'), 'CUSTOMER_REQUEST', 'OFFICE')
      await cancelRide(ride('STARTED', papy), 'CUSTOMER_REQUEST', 'OFFICE')
      assert.deepStrictEqual(await removals(), [], 'no driver yet, or one already driving it: nobody to tell')
      assert.strictEqual(pushes, 0, 'a driver is texted, never pushed')
   })

   console.log('\nNotification templates on an existing database')
   await check('every event has one default, in documented variables only', () => {
      const events = NOTIFICATION_TEMPLATE_DEFAULTS.map((t) => t.event).sort()
      assert.deepStrictEqual(events, Object.values(NOTIFICATION_EVENTS).sort(), 'an event with no default sends nothing')
      for (const t of NOTIFICATION_TEMPLATE_DEFAULTS) {
         for (const [, v] of t.body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
            assert.ok((TEMPLATE_VARIABLES as readonly string[]).includes(v), `${t.event}: {{${v}}} is not a template variable`)
         }
      }
   })
   await check('a boot adds the SMS default of each event with none (bar one the office deleted), and leaves every template it finds as it is', async () => {
      const office = [
         { event: 'ORDER_CONFIRMED', channel: 'SMS', body: 'Edited by the office', isActive: true },
         { event: 'TRANSFER_STARTED', channel: 'SMS', body: 'Switched off', isActive: false },
         { event: 'DRIVER_WELCOME', channel: 'PUSH', body: 'A push only', isActive: true },
      ]
      const stored: any[] = office.map((t) => ({ ...t }))
      const audits: any[] = []
      ;(NotificationTemplate as any).distinct = async (field: string, f: any) => [
         ...new Set(stored.filter((t) => Object.entries(f).every(([k, v]) => t[k] === v)).map((t) => t[field])),
      ]
      ;(NotificationTemplate as any).insertMany = async (rows: any[]) => stored.push(...rows.map((r) => ({ ...r })))
      for (const write of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'bulkWrite']) {
         ;(NotificationTemplate as any)[write] = () => {
            throw new Error(`${write}: a template already there was touched`)
         }
      }
      ;(AuditLog as any).create = async (doc: any) => audits.push(doc)
      // The office deleted QUOTE_SENT's SMS (and a push one, which does not count).
      const purged = [
         { action: 'PURGE', entityType: 'NotificationTemplate', before: { event: 'QUOTE_SENT', channel: 'SMS' } },
         { action: 'PURGE', entityType: 'NotificationTemplate', before: { event: 'DRIVER_RIDE_REMOVED', channel: 'PUSH' } },
      ]
      const at = (o: any, path: string) => path.split('.').reduce((v, k) => v?.[k], o)
      ;(AuditLog as any).distinct = async (field: string, f: any) => [
         ...new Set(purged.filter((a) => Object.entries(f).every(([k, v]) => at(a, k) === v)).map((a) => at(a, field))),
      ]
      const log = console.log
      console.log = () => undefined
      try {
         assert.strictEqual(await ensureDefaultTemplates(), NOTIFICATION_TEMPLATE_DEFAULTS.length - 3)
         assert.strictEqual(await ensureDefaultTemplates(), 0, 'the next boot has nothing to add')
      } finally {
         console.log = log
      }
      assert.deepStrictEqual(stored.slice(0, 3), office, "the office's templates are as they were")
      const sms = (event: string) => stored.filter((t) => t.event === event && t.channel === 'SMS')
      assert.strictEqual(sms('ORDER_CONFIRMED').length, 1, 'edited: kept, not doubled')
      assert.strictEqual(sms('TRANSFER_STARTED').length, 1, 'switched off: stays off')
      assert.strictEqual(sms('DRIVER_WELCOME').length, 1, 'a push template is not an SMS one: the SMS default is added')
      assert.strictEqual(sms('QUOTE_SENT').length, 0, 'deleted by the office: stays deleted')
      assert.strictEqual(sms('DRIVER_RIDE_REMOVED')[0]?.isActive, true)
      assert.ok(sms('DRIVER_RIDE_REMOVED')[0].body.includes('ne vous est plus attribuée'))
      assert.strictEqual(audits.length, 1, 'one audit entry, from the boot that added some')
      assert.strictEqual(audits[0].action, 'NOTIFICATION_TEMPLATES_ADDED')
      assert.strictEqual(audits[0].after.count, NOTIFICATION_TEMPLATE_DEFAULTS.length - 3)
   })

   console.log('\nDriver sign-in')
   await check('an unknown number costs a password compare, like a wrong password', async () => {
      await verifyPassword('warm-up', undefined) // builds the stand-in hash
      const t0 = Date.now()
      assert.strictEqual(await verifyPassword('wrong', undefined), false)
      const ms = Date.now() - t0
      assert.ok(ms >= 20, `refused in ${ms} ms: an instant "no" tells a prober which numbers are ours`)
   })

   console.log('\nDTOs')
   const driver = {
      _id: 'd1',
      name: 'Papy',
      phone: '+243810000101',
      photo: 'p.jpg',
      licenceNumber: 'LEAKED-LICENCE',
      password: 'LEAKED-HASH',
      passwordChangedAt: new Date(),
      ratingStats: { rating: 4.5, count: 2 },
   }
   const ride = (status: string) => ({
      _id: 'r1',
      reference: 'FA-TEST-RIDE',
      status,
      mode: 'DISTANCE',
      city: 'Kinshasa',
      pickup: NDJILI,
      dropoff: MEMLING,
      at: new Date('2026-11-03T08:30:00.000Z'),
      passengers: 2,
      categoryName: 'Berline',
      distanceKm: 22,
      durationMinutes: 44,
      price: { CDF: 40_000 },
      cost: { CDF: 24_200 },
      customer: 'c0ffee',
      customerName: 'Jean Test',
      customerPhone: '+243810000042',
      customerEmail: 'leak@example.com',
      driver,
      vehicle: { _id: 'v1', make: 'Toyota', model: 'Corolla', plate: 'KN 1234 AB' },
      timeline: [{ at: new Date(), event: 'RIDE_ASSIGNED', actor: 'OFFICE', detail: 'internal' }],
      alerts: [],
   })
   const canaries = ['LEAKED', '24200', 'leak@example.com', 'c0ffee']

   await check('the public category carries the prices and never the costs', () => {
      const out: any = presentPublicCategory({ _id: 'c1', name: { fr: 'Berline' }, seats: 3, ...berline })
      assert.ok(!('costPerKm' in out) && !('costPerHour' in out))
      assert.ok(!JSON.stringify(out).includes('1100'), 'the cost per km reached the customer')
      assert.strictEqual(out.pricePerKm.CDF, 1_800)
   })
   await check('the customer sees no driver before one is assigned, then the driver without their secrets', () => {
      const pending: any = presentPublicRide(ride('PENDING'))
      assert.strictEqual(pending.driver, undefined)
      assert.strictEqual(pending.vehicle, undefined)
      assert.strictEqual(pending.canRate, false)
      const assigned: any = presentPublicRide(ride('ASSIGNED'))
      assert.strictEqual(assigned.driver.phone, '+243810000101')
      assert.deepStrictEqual(Object.keys(assigned.driver).sort(), ['count', 'name', 'phone', 'photo', 'rating'])
      for (const r of [pending, assigned]) {
         const s = JSON.stringify(r)
         for (const c of canaries) assert.ok(!s.includes(c), `public ride leaked "${c}"`)
      }
      const done: any = presentPublicRide({ ...ride('COMPLETED'), endedAt: new Date() })
      assert.strictEqual(done.canRate, true)
      assert.strictEqual(done.canAlert, true)
   })
   await check("the driver's ride names the customer and the price, never their account or the cost", () => {
      const out: any = presentDriverRide(ride('ASSIGNED'), { paymentMethod: 'CASH', paymentStatus: 'UNPAID' })
      assert.deepStrictEqual(out.customer, { name: 'Jean Test', phone: '+243810000042' })
      assert.strictEqual(out.price.CDF, 40_000)
      assert.strictEqual(out.payment.paid, false)
      assert.ok(!('cost' in out))
      const s = JSON.stringify(out)
      for (const c of canaries) assert.ok(!s.includes(c), `driver ride leaked "${c}"`)
      assert.ok(!s.includes('internal'), 'timeline details are the office\'s')
   })
   await check('the admin ride carries the cost and the whole timeline (its surface only)', () => {
      const out: any = presentRideDetail(ride('ASSIGNED'))
      assert.strictEqual(out.cost, 24_200)
      assert.strictEqual(out.timeline[0].detail, 'internal')
      assert.ok(!JSON.stringify(out).includes('LEAKED'), 'the driver hash or licence reached the admin ride')
   })

   console.log(failures === 0 ? '\nAll transfer checks passed.\n' : `\n${failures} transfer check(s) FAILED.\n`)
   process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
   console.error(err)
   process.exit(1)
})
