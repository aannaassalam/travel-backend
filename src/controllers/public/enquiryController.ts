import { Request, Response } from 'express'
import { VERTICALS } from '../../constants/domain.constants'
import { Enquiry, ENQUIRY_KINDS } from '../../model/enquiryModel'
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

/** POST /api/v1/enquiries */
export const createEnquiry = catchAsync(async (req: Request, res: Response) => {
   const { kind, vertical, customerName, phone, email, message, listingLabel } = req.body ?? {}

   const name = String(customerName ?? '').trim()
   if (name.length < 3) throw new AppError('A full name is required', 400)

   const e164 = normalisePhone(phone ?? '')
   if (!e164) throw new AppError('A valid phone number is required', 400)

   const body = String(message ?? '').trim()
   if (!body) throw new AppError('A message is required', 400)

   const resolvedKind = Object.values(ENQUIRY_KINDS).includes(kind)
      ? kind
      : ENQUIRY_KINDS.REQUEST_TO_BOOK
   const resolvedVertical = Object.values(VERTICALS).includes(vertical)
      ? vertical
      : VERTICALS.PROPERTY

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
      listingLabel: String(listingLabel ?? '').trim() || undefined,
      source: 'WEB',
      contactLog: idempotencyKey
         ? [{ kind: 'NOTE', detail: `idem:${idempotencyKey}` }]
         : [],
   })

   sendResponse(res, 201, 'Enquiry received', { reference: enquiry.reference })
})
