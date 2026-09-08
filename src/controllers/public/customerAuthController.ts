import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import { presentOrder } from '../../dto/public/order.dto'
import { Customer } from '../../model/customerModel.admin'
import { Order } from '../../model/orderModel'
import { PhoneVerification } from '../../model/phoneVerificationModel'
import {
   CUSTOMER_SESSION_MS,
   MIN_PASSWORD_LENGTH,
   clearCustomerCookie,
   deliverOtp,
   generateOtp,
   hashOtp,
   hashPassword,
   setCustomerCookie,
   signCustomerToken,
   verifyPassword,
} from '../../middleware/customerAuth'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Customer sign-in.
 *
 * The phone IS the identity. A one-time code proves it ONCE, at sign-up; from
 * then on the customer signs in with that number and a password they chose.
 * The SMS is the expensive part of this system — one per lifetime instead of
 * one per sign-in is the whole point — and it stays the only way to recover an
 * account, so possession of the handset remains the root of trust.
 */

const OTP_TTL_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 5
/** Stops one number being used as an SMS cannon at someone else's handset. */
const RESEND_COOLDOWN_MS = 60 * 1000

/** §7.2: one canonical form, or "the same customer" stops meaning anything. */
export const normalisePhone = (raw: string) => {
   const trimmed = String(raw ?? '').replace(/[\s.-]/g, '')
   if (/^\+\d{8,15}$/.test(trimmed)) return trimmed
   if (/^0\d{8,12}$/.test(trimmed)) return `+243${trimmed.slice(1)}`
   if (/^\d{8,15}$/.test(trimmed)) return `+${trimmed}`
   return null
}

// ---------------------------------------------------------------------------
// POST /auth/otp/request
// ---------------------------------------------------------------------------

/**
 * §7.4 anti-enumeration: the response is identical whether or not the number is
 * known to us. Answering differently would turn this endpoint into a way to ask
 * "is this person a customer of yours", which is exactly the question a stalker
 * or a competitor wants answered.
 */
export const requestOtp = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const phone = normalisePhone(req.body?.phone)
      if (!phone) return next(new AppError('A valid phone number is required', 400))

      const outstanding = await PhoneVerification.findOne({ phone })
      const cooling =
         outstanding &&
         Date.now() - new Date(outstanding.lastSentAt).getTime() < RESEND_COOLDOWN_MS

      if (!cooling) {
         const code = generateOtp()
         await PhoneVerification.findOneAndUpdate(
            { phone },
            {
               $set: {
                  codeHash: hashOtp(code),
                  expiresAt: new Date(Date.now() + OTP_TTL_MS),
                  attempts: 0,
                  lastSentAt: new Date(),
               },
            },
            { upsert: true }
         )
         try {
            await deliverOtp(phone, code)
         } catch (err) {
            /**
             * The provider refused. The customer has to be told, or they wait
             * for a code that is never coming — but they get a clean sentence,
             * not Twilio's wording and certainly not a stack trace with server
             * paths, which is what an unhandled throw was returning here.
             *
             * The real reason is logged for the office: a geo-permission block
             * (Twilio 21408) or an unverified trial number look identical from
             * the outside and are fixed in completely different places.
             */
            const detail = (err as Error).message
            console.error(`[otp] delivery failed for ${phone}: ${detail}`)
            // The unusable code must not sit there blocking a retry.
            await PhoneVerification.deleteOne({ phone })
            return next(
               new AppError(
                  'We could not send a code to that number. Check it is correct, or contact support.',
                  502,
                  'OTP_DELIVERY_FAILED'
               )
            )
         }
      }

      // Always the same answer, and always the same shape. The code itself is
      // never in the response — it goes to the handset or nowhere.
      return sendResponse(res, 200, 'If that number is valid, a code has been sent', {
         expiresInSeconds: OTP_TTL_MS / 1000,
      })
   }
)

/**
 * Checks an outstanding code without spending it — sign-up and password reset
 * both need exactly this, and a second copy of it is a second place for the
 * attempt counter to be forgotten.
 *
 * Returns the record on success so the caller can delete it once the operation
 * can no longer fail; returns an AppError otherwise. Deliberately the same
 * error for "no code outstanding", "expired" and "wrong" — distinguishing them
 * tells an attacker which numbers are live.
 */
const checkOtp = async (phone: string, code: string) => {
   const record = await PhoneVerification.findOne({ phone })
   const invalid = new AppError('That code is not valid', 400, 'OTP_INVALID')

   if (!record || record.expiresAt.getTime() < Date.now()) return { error: invalid }

   if (record.attempts >= MAX_ATTEMPTS) {
      // Burn it rather than leaving it guessable for the rest of its TTL.
      await PhoneVerification.deleteOne({ _id: record._id })
      return {
         error: new AppError('Too many attempts. Request a new code.', 429, 'OTP_LOCKED'),
      }
   }

   if (record.codeHash !== hashOtp(code)) {
      await PhoneVerification.updateOne({ _id: record._id }, { $inc: { attempts: 1 } })
      return { error: invalid }
   }

   return { record }
}

/** §7.5: one rule, so the client and the server cannot disagree about it. */
const checkPassword = (raw: unknown) => {
   const password = String(raw ?? '')
   if (password.length < MIN_PASSWORD_LENGTH) {
      return {
         error: new AppError(
            `Your password must be at least ${MIN_PASSWORD_LENGTH} characters`,
            400,
            'PASSWORD_WEAK'
         ),
      }
   }
   return { password }
}

// ---------------------------------------------------------------------------
// POST /auth/otp/verify — sign-up
// ---------------------------------------------------------------------------

export const verifyOtp = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const phone = normalisePhone(req.body?.phone)
      const code = String(req.body?.code ?? '').trim()
      if (!phone || !/^\d{4,8}$/.test(code)) {
         return next(new AppError('Phone and code are required', 400))
      }

      const { record, error } = await checkOtp(phone, code)
      if (error || !record) return next(error!)

      /**
       * The account. An existing contact — someone who checked out as a guest
       * before — is upgraded in place rather than duplicated, so their booking
       * history is there the moment they sign in.
       */
      const firstName = String(req.body?.firstName ?? '').trim().slice(0, 80)
      const lastName = String(req.body?.lastName ?? '').trim().slice(0, 80)
      const existing = await Customer.findOne({ phone }).select('+password')

      /**
       * A number that already has a password is signing in on the wrong flow —
       * they want /auth/login. Say so, rather than quietly opening a session:
       * the whole point of the change is that the SMS is spent once.
       */
      if (existing?.password) {
         return next(
            new AppError(
               'This number already has an account. Sign in with your password.',
               409,
               'ACCOUNT_EXISTS'
            )
         )
      }

      /**
       * A brand-new number needs a name and a password, and the client cannot
       * know in advance that the number is new — telling it up front would leak
       * exactly what §7.4 forbids. So: answer NAME_REQUIRED and let them submit
       * the SAME code again with the details. The code must therefore still be
       * alive — it is only spent below, once sign-up cannot fail. Burning it
       * here stranded every new customer with a dead code and no way to finish.
       */
      if (!firstName) {
         return next(
            new AppError('A first name is required to create an account', 400, 'NAME_REQUIRED')
         )
      }
      const { password, error: weak } = checkPassword(req.body?.password)
      if (weak || !password) return next(weak!)

      // Spent. One code, one use — from here the sign-up cannot fail.
      await PhoneVerification.deleteOne({ _id: record._id })

      const customer =
         existing ??
         (await Customer.create({ phone, firstName, lastName, hasAccount: false }))

      await Customer.updateOne(
         { _id: customer._id },
         {
            $set: {
               hasAccount: true,
               phoneVerifiedAt: new Date(),
               password: await hashPassword(password),
               firstName,
               ...(lastName ? { lastName } : {}),
            },
         }
      )

      const fresh = await Customer.findById(customer._id)
      const token = signCustomerToken(customer._id.toString())
      setCustomerCookie(res, token)

      return sendResponse(res, 200, 'Signed in', {
         token,
         expiresIn: CUSTOMER_SESSION_MS / 1000,
         customer: {
            firstName: fresh?.firstName ?? '',
            lastName: fresh?.lastName ?? '',
            phone: fresh?.phone,
            email: fresh?.email,
            hasAccount: true,
         },
      })
   }
)

// ---------------------------------------------------------------------------
// POST /auth/login — phone + password
// ---------------------------------------------------------------------------

/**
 * The everyday route in. No SMS, so no cost and no waiting for a network that
 * is not always there.
 *
 * One error for every failure — unknown number, wrong password, blocked, or a
 * contact record that never became an account. Anything more specific answers
 * "is this person a customer of yours" to anyone who types a number (§7.4),
 * which is the same leak the OTP endpoint is careful to avoid.
 */
export const login = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const phone = normalisePhone(req.body?.phone)
      const password = String(req.body?.password ?? '')
      if (!phone || !password) {
         return next(new AppError('Phone number and password are required', 400))
      }

      const customer = await Customer.findOne({ phone }).select('+password')
      const ok =
         customer &&
         customer.hasAccount &&
         !customer.isBlocked &&
         (await verifyPassword(password, customer.password))

      if (!ok) {
         return next(
            new AppError('That phone number or password is not correct', 401, 'BAD_CREDENTIALS')
         )
      }

      const token = signCustomerToken(customer!._id.toString())
      setCustomerCookie(res, token)

      return sendResponse(res, 200, 'Signed in', {
         token,
         expiresIn: CUSTOMER_SESSION_MS / 1000,
         customer: {
            firstName: customer!.firstName ?? '',
            lastName: customer!.lastName ?? '',
            phone: customer!.phone,
            email: customer!.email,
            hasAccount: true,
         },
      })
   }
)

// ---------------------------------------------------------------------------
// POST /auth/password/reset — forgotten password
// ---------------------------------------------------------------------------

/**
 * The code comes from the ordinary /auth/otp/request, which already answers
 * identically for known and unknown numbers. This spends it and sets the new
 * password in one call: an intermediate "reset token" would be a second
 * credential to mint, store, transport and expire, and the code is already
 * short-lived, single-use and attempt-limited. The client shows two screens
 * over one request, which is a client concern.
 *
 * Signing them in on success is deliberate — being bounced back to a login form
 * to retype a password chosen ten seconds ago is a pointless last hurdle.
 */
export const resetPassword = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const phone = normalisePhone(req.body?.phone)
      const code = String(req.body?.code ?? '').trim()
      if (!phone || !/^\d{4,8}$/.test(code)) {
         return next(new AppError('Phone and code are required', 400))
      }

      const { password, error: weak } = checkPassword(req.body?.password)
      if (weak || !password) return next(weak!)

      const { record, error } = await checkOtp(phone, code)
      if (error || !record) return next(error!)

      const customer = await Customer.findOne({ phone })
      /**
       * The code was valid, so the caller holds the handset — but there is no
       * account on this number to reset. Sending them to sign-up is the honest
       * answer and reveals nothing they did not just prove.
       */
      if (!customer || !customer.hasAccount) {
         await PhoneVerification.deleteOne({ _id: record._id })
         return next(
            new AppError('There is no account on this number yet', 404, 'NO_ACCOUNT')
         )
      }

      await PhoneVerification.deleteOne({ _id: record._id })
      await Customer.updateOne(
         { _id: customer._id },
         { $set: { password: await hashPassword(password), phoneVerifiedAt: new Date() } }
      )

      const token = signCustomerToken(customer._id.toString())
      setCustomerCookie(res, token)

      return sendResponse(res, 200, 'Password updated', {
         token,
         expiresIn: CUSTOMER_SESSION_MS / 1000,
         customer: {
            firstName: customer.firstName ?? '',
            lastName: customer.lastName ?? '',
            phone: customer.phone,
            email: customer.email,
            hasAccount: true,
         },
      })
   }
)

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const me = catchAsync(async (req: Request, res: Response) => {
   const c = (req as any).customer
   return sendResponse(res, 200, 'OK', {
      customer: {
         firstName: c.firstName,
         lastName: c.lastName,
         phone: c.phone,
         email: c.email,
         hasAccount: c.hasAccount,
      },
   })
})

/**
 * PATCH /auth/me — the customer editing their own details.
 *
 * Phone is deliberately NOT editable here: it is the account identity and the
 * thing the one-time code proved. Changing it would have to re-verify the new
 * number, which is a different flow.
 */
export const updateMe = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const c = (req as any).customer
      const patch: Record<string, unknown> = {}

      if (req.body?.firstName !== undefined) {
         const v = String(req.body.firstName).trim().slice(0, 80)
         if (!v) return next(new AppError('First name cannot be empty', 400))
         patch.firstName = v
      }
      if (req.body?.lastName !== undefined) {
         patch.lastName = String(req.body.lastName).trim().slice(0, 80)
      }
      if (req.body?.email !== undefined) {
         const v = String(req.body.email).trim().toLowerCase()
         if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
            return next(new AppError('That email address is not valid', 400))
         }
         patch.email = v
      }

      await Customer.updateOne({ _id: c._id }, { $set: patch })
      const fresh = await Customer.findById(c._id)
      return sendResponse(res, 200, 'Profile saved', {
         customer: {
            firstName: fresh?.firstName ?? '',
            lastName: fresh?.lastName ?? '',
            phone: fresh?.phone,
            email: fresh?.email,
            hasAccount: fresh?.hasAccount,
         },
      })
   }
)

/**
 * DELETE /auth/me — §12.4 (Apple 5.1.1(v)) in-app account deletion.
 *
 * Anonymised, not erased. The privacy page states that paid bookings stay on
 * record for accounting and legal reasons, and hard-deleting the customer would
 * orphan every order that points at them — the office would be left with
 * revenue it cannot attribute. So the personal data goes and the row stays:
 * name blanked, email dropped, phone replaced with an irreversible digest so
 * the same person signing up again cannot be re-linked to their old history.
 */
export const deleteMe = catchAsync(async (req: Request, res: Response) => {
   const c = (req as any).customer
   const tombstone = `deleted-${crypto
      .createHash('sha256')
      .update(String(c.phone))
      .digest('hex')
      .slice(0, 24)}`

   await Customer.updateOne(
      { _id: c._id },
      {
         $set: {
            firstName: 'Deleted',
            lastName: '',
            phone: tombstone,
            hasAccount: false,
            deletedAt: new Date(),
         },
         $unset: { email: 1, phoneVerifiedAt: 1, password: 1 },
      }
   )
   clearCustomerCookie(res)
   return sendResponse(res, 200, 'Account deleted', {})
})

export const logout = catchAsync(async (_req: Request, res: Response) => {
   clearCustomerCookie(res)
   return sendResponse(res, 200, 'Signed out', {})
})

/**
 * GET /me/orders — every order belonging to the signed-in phone, on any device.
 *
 * This is what makes an account worth having: a guest's bookings live only in
 * the browser that made them, and are gone with the site data.
 */
export const myOrders = catchAsync(async (req: Request, res: Response) => {
   const c = (req as any).customer
   const orders = await Order.find({ customer: c._id })
      .sort({ _id: -1 })
      .limit(100)
      .select('+travellers.documentNumber')
      .populate('customer', 'phone')
   return sendResponse(res, 200, 'OK', { items: orders.map(presentOrder) })
})
