import { Request, Response } from 'express'
import { VERTICALS } from '../../constants/domain.constants'
import { Enquiry, ENQUIRY_KINDS } from '../../model/enquiryModel'
import { NOTIFICATION_EVENTS } from '../../model/enquiryModel'
import { notify } from '../../services/notifications/notify.service'
import { parsePassengers } from '../../services/orders/pricing.service'
import { KINSHASA_OFFSET, TIME_RX } from '../../services/orders/schedule.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * §7 lead capture — the public end of Request-to-Book (archetype B) and the
 * only conversion path property has (archetype C).
 *
 * §14.3: the response carries the reference and nothing else. It never echoes
 * back the stored document, because the moment it does, someone adds a field to
 * the model and the public surface grows it silently.
 */

/** Same shape the customer realm already uses. */
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** §14.3 rule 4: unguessable. Sequential ids invite someone to walk the table. */
const makeReference = () => {
   let out = ''
   for (let i = 0; i < 10; i++) out += B32[Math.floor(Math.random() * B32.length)]
   return `DM-${out.slice(0, 5)}-${out.slice(5)}`
}

/** E.164 with the DRC default (§7.1). Server-side — the client's check is UX. */
const normalisePhone = (input: string): string | null => {
   const digits = String(input).replace(/[^\d+]/g, '')
   if (digits.startsWith('+')) return /^\+\d{9,15}$/.test(digits) ? digits : null
   const local = digits.replace(/^0+/, '')
   return /^\d{9,10}$/.test(local) ? `+243${local}` : null
}

const HOUR_MS = 3_600_000

/**
 * A bus or flight request's trip: the day and time the customer wants and who
 * travels, so the office can look for seats without calling back to ask.
 *
 * Not checked against the timetable — a request may be for a time the route
 * does not run. It must be a real day and time still to come (Kinshasa time,
 * with the hour's grace a car hire gets) within a year, and the travellers
 * follow the booking rules (parsePassengers).
 */
export const readTrip = (raw: any, now = Date.now()) => {
   const date = String(raw?.date ?? '')
   const time = String(raw?.time ?? '')
   const at =
      /^\d{4}-\d{2}-\d{2}$/.test(date) && TIME_RX.test(time)
         ? Date.parse(`${date}T${time}:00${KINSHASA_OFFSET}`)
         : NaN
   // `Date` rolls 2026-02-31 into March; a day that is not real is refused.
   const real =
      !Number.isNaN(at) && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date
   if (!real || at < now - HOUR_MS || at > now + 366 * 24 * HOUR_MS) {
      throw new AppError('Choose a travel date and time still to come, within a year', 400)
   }
   try {
      return { date, time, ...parsePassengers(raw) }
   } catch {
      throw new AppError(
         'At least one adult travels, with no more babies than adults and 20 people at most',
         400
      )
   }
}

/** POST /api/v1/enquiries */
export const createEnquiry = catchAsync(async (req: Request, res: Response) => {
   const { kind, vertical, customerName, phone, email, message, listingLabel, trip } =
      req.body ?? {}

   const name = String(customerName ?? '').trim()
   if (name.length < 3) throw new AppError('A full name is required', 400)
   // §BUG-015: cap the free-text fields and refuse a malformed e-mail.
   if (name.length > 120) throw new AppError('That name is too long', 400)

   const e164 = normalisePhone(phone ?? '')
   if (!e164) throw new AppError('A valid phone number is required', 400)

   const mail = String(email ?? '').trim()
   if (mail && !EMAIL_RX.test(mail.toLowerCase())) {
      throw new AppError('That email address is not valid', 400)
   }

   // The page's own title, sent by the website and the app — not typed by the
   // customer, who could not shorten it. Refusing a long one lost every lead
   // for a listing titled over 120 characters (the import allows 200), so it is
   // cut instead, like the message below.
   const label = String(listingLabel ?? '').trim().slice(0, 120)

   const body = String(message ?? '').trim()
   if (!body) throw new AppError('A message is required', 400)

   const resolvedKind = Object.values(ENQUIRY_KINDS).includes(kind)
      ? kind
      : ENQUIRY_KINDS.REQUEST_TO_BOOK
   const resolvedVertical = Object.values(VERTICALS).includes(vertical)
      ? vertical
      : VERTICALS.PROPERTY
   // Only a bus or flight has a departure to ask about; anything else drops it.
   const resolvedTrip =
      trip != null && [VERTICALS.BUS, VERTICALS.FLIGHT].includes(resolvedVertical)
         ? readTrip(trip)
         : undefined

   /**
    * §4.6 idempotency. A dropped response on a metered mobile network gets
    * retried, and a duplicate lead wastes a callback. Same key + same phone
    * within the window replays the original reference instead of inserting.
    */
   const idempotencyKey = req.header('Idempotency-Key')
   if (idempotencyKey) {
      const existing = await Enquiry.findOne({
         phone: e164,
         'contactLog.detail': `idem:${idempotencyKey}`,
         createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
      })
      if (existing) {
         return sendResponse(res, 200, 'Enquiry already received', {
            reference: existing.reference,
         })
      }
   }

   const enquiry = await Enquiry.create({
      reference: makeReference(),
      kind: resolvedKind,
      vertical: resolvedVertical,
      customerName: name,
      phone: e164,
      email: String(email ?? '').trim() || undefined,
      message: body.slice(0, 2000),
      listingLabel: label || undefined,
      trip: resolvedTrip,
      source: 'WEB',
      contactLog: idempotencyKey
         ? [{ kind: 'NOTE', detail: `idem:${idempotencyKey}` }]
         : [],
   })

   // Acknowledge the lead. §7 makes an unanswered enquiry the thing to avoid;
   // the first thing that stops it is the customer knowing it arrived.
   void notify({
      event: NOTIFICATION_EVENTS.ENQUIRY_RECEIVED,
      recipient: enquiry.phone,
      vars: {
         customer_name: enquiry.customerName,
         order_ref: enquiry.reference,
         listing_title: enquiry.listingLabel ?? '',
         // The office's template may quote the departure asked for, as an order's does.
         departure_date: resolvedTrip ? `${resolvedTrip.date} ${resolvedTrip.time}` : undefined,
      },
   })

   sendResponse(res, 201, 'Enquiry received', { reference: enquiry.reference })
})

// Self-check: `npx ts-node --transpile-only src/controllers/public/enquiryController.ts`
if (require.main === module) {
   const assert: typeof import('assert') = require('assert')
   const now = Date.parse('2030-01-07T10:00:00+01:00') // Monday 10:00 in Kinshasa
   const ok = (raw: any) => readTrip(raw, now)
   const refused = (raw: any) => assert.throws(() => readTrip(raw, now), AppError)
   const pax = { adults: 2, children: 1, infants: 1 }

   assert.deepStrictEqual(ok({ date: '2030-01-09', time: '06:30', ...pax }), {
      date: '2030-01-09',
      time: '06:30',
      ...pax,
   })
   // Numbers as text, blanks as none: what a form sends.
   assert.deepStrictEqual(ok({ date: '2030-01-07', time: '14:00', adults: '1', children: '' }), {
      date: '2030-01-07',
      time: '14:00',
      adults: 1,
      children: 0,
      infants: 0,
   })
   assert.ok(ok({ date: '2030-01-07', time: '09:15', adults: 1 })) // within the hour's grace
   refused({ date: '2030-01-07', time: '08:30', adults: 1 }) // left over an hour ago
   refused({ date: '2030-01-06', time: '12:00', adults: 1 }) // yesterday
   refused({ date: '2031-01-09', time: '12:00', adults: 1 }) // over a year out
   refused({ date: '2030-02-31', time: '12:00', adults: 1 }) // no such day
   refused({ date: '2030-01-09', time: '24:00', adults: 1 })
   refused({ date: '2030-01-09', time: '6:30', adults: 1 })
   refused({ date: '2030-01-09', time: '06:30', adults: 0, children: 1 }) // no adult
   refused({ date: '2030-01-09', time: '06:30', adults: 1, infants: 2 }) // a lap each
   refused({ date: '2030-01-09', time: '06:30', adults: 1.5 })
   refused('2030-01-09 06:30')
   console.log('enquiry trip: ok')
}
