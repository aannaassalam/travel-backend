import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { Customer } from '../model/customerModel.admin'
import { sendSms } from '../services/notifications/sms.service'
import AppError from '../utils/appError'
import catchAsync from '../utils/catchAsync'

/**
 * Customer sessions for the public site.
 *
 * §1.3: a completely separate key and audience from the admin. A customer token
 * must be structurally unable to reach /admin/v1 — not merely refused by a role
 * check, but unverifiable there at all. `adminJwtSecret()` already refuses to
 * start if the two secrets match.
 */

export const CUSTOMER_COOKIE = 'ct_session'
export const CUSTOMER_AUDIENCE = 'customer'
export const SESSION_INVALID = 'SESSION_INVALID'

/** 7 days, matching the cookie, so neither expires while the other is alive. */
export const CUSTOMER_SESSION_MS = Number(process.env.CUSTOMER_SESSION_DAYS || 7) * 86400_000

/**
 * How long a session can be kept alive by use before the customer has to prove
 * the phone again. The sliding window below would otherwise renew forever, and
 * a session that never ends is a stolen cookie that never expires.
 */
export const CUSTOMER_ABSOLUTE_MAX_MS =
   Number(process.env.CUSTOMER_SESSION_MAX_DAYS || 90) * 86400_000

/**
 * Renew once the token is older than this. Not on every request: that would put
 * a Set-Cookie on every authenticated response for no benefit.
 */
const REFRESH_AFTER_MS = 86400_000

const customerJwtSecret = () => {
   const secret = process.env.JWT_SECRET
   if (!secret) throw new Error('JWT_SECRET is not defined')
   return secret
}

/**
 * `authAt` is when the customer last proved the phone with an OTP, and it is
 * carried forward unchanged by every renewal. It is what makes the absolute cap
 * possible: without it a renewed token looks brand new and the session could be
 * extended indefinitely one request at a time.
 */
export const signCustomerToken = (customerId: string, authAt = Date.now()) =>
   jwt.sign({ sub: customerId, authAt }, customerJwtSecret(), {
      audience: CUSTOMER_AUDIENCE,
      expiresIn: CUSTOMER_SESSION_MS / 1000,
   })

/**
 * httpOnly so no script can read it — §7.3 forbids putting a session token in
 * localStorage. An explicit maxAge makes it persistent; without one the browser
 * drops it when the window closes, which the user experiences as being signed
 * out constantly.
 *
 * SameSite has to be 'none' whenever the site and the API are different
 * registrable domains (the frontend on Vercel, this API on flexiairbnb.com).
 * Under 'lax' the browser stores the cookie and then withholds it from every
 * cross-site fetch, so login appears to succeed and the next request is
 * anonymous. 'none' requires Secure, which is why it is tied to HTTPS.
 *
 * The CSRF protection 'lax' was providing is replaced by the CORS allow-list in
 * app.ts: a JSON POST from an unlisted origin is refused at preflight. Host the
 * frontend on a flexiairbnb.com subdomain and this can go back to 'lax'.
 */
const cookieOptions = () => {
   const crossSite = process.env.NODE_ENV === 'production'
   return {
      httpOnly: true,
      sameSite: crossSite ? ('none' as const) : ('lax' as const),
      secure: crossSite,
      path: '/',
   }
}

export const setCustomerCookie = (res: Response, token: string) => {
   res.cookie(CUSTOMER_COOKIE, token, {
      ...cookieOptions(),
      maxAge: CUSTOMER_SESSION_MS,
   })
}

// Same attributes as when it was set, or the browser treats it as a different
// cookie and the old one survives the logout.
export const clearCustomerCookie = (res: Response) =>
   res.clearCookie(CUSTOMER_COOKIE, cookieOptions())

const readToken = (req: Request) => {
   const header = req.headers.authorization
   if (header?.startsWith('Bearer ')) return header.slice(7)
   return (req as any).cookies?.[CUSTOMER_COOKIE] as string | undefined
}

/** Resolves the signed-in customer, or null. Never throws — for optional auth. */
export const currentCustomer = async (req: Request) => {
   const token = readToken(req)
   if (!token) return null
   try {
      const decoded: any = jwt.verify(token, customerJwtSecret(), {
         audience: CUSTOMER_AUDIENCE,
      })
      const customer = await Customer.findById(decoded.sub)
      if (!customer || customer.isBlocked || !customer.hasAccount) return null
      /**
       * A password reset ends every session opened before it. Without this a
       * lost or sold phone stayed signed in after its owner — or the next
       * holder of a recycled number — reset the password, and went on
       * re-registering itself for that account's booking notifications.
       */
      const changedAt = (customer as any).passwordChangedAt?.getTime?.()
      if (changedAt && decoded.iat && decoded.iat * 1000 < changedAt) return null
      // Stashed so the guard can renew without verifying the token a second time.
      ;(req as any).customerToken = decoded
      return customer
   } catch {
      return null
   }
}

/**
 * Sliding renewal.
 *
 * Every OTP costs real money at Twilio, so a customer who uses the site should
 * never be asked for one again — the fixed 7-day window meant a fortnightly
 * visitor paid for an SMS every single visit. Once a token is more than a day
 * old it is re-issued with a fresh 7 days, so the window follows the customer.
 *
 * The cookie IS the refresh token here. It is httpOnly, rotated on renewal, and
 * scoped to the API, which is what a separate refresh token would buy — without
 * a second credential to store, transport and revoke.
 *
 * `authAt` is preserved, so the absolute cap still bites: after
 * CUSTOMER_SESSION_MAX_DAYS from the last real OTP the renewal stops and the
 * customer proves the phone again.
 *
 * ponytail: no refresh-token rotation or reuse detection, and no server-side
 * session list — a customer session cannot be revoked before it expires. Add
 * both if account takeover becomes a real concern; the admin side already has
 * the revocable-session shape to copy.
 */
const renewIfStale = (req: Request, res: Response) => {
   const decoded: any = (req as any).customerToken
   if (!decoded?.exp) return

   const issuedAt = decoded.iat ? decoded.iat * 1000 : 0
   if (!issuedAt || Date.now() - issuedAt < REFRESH_AFTER_MS) return

   // Tokens minted before `authAt` existed have no anchor, so treat this
   // request as the anchor rather than refusing to renew a valid session.
   const authAt = Number(decoded.authAt) || Date.now()
   if (Date.now() - authAt >= CUSTOMER_ABSOLUTE_MAX_MS) return

   const renewed = signCustomerToken(String(decoded.sub), authAt)
   setCustomerCookie(res, renewed)
   /**
    * The mobile app authenticates with a Bearer token and ignores Set-Cookie
    * entirely, so cookie-only renewal would leave it hard-expiring at seven
    * days — re-running the OTP, and re-paying Twilio, exactly as before. The
    * header is how a non-cookie client learns its session moved.
    *
    * Safe to expose: it is the caller's own session, replacing the one it just
    * presented. It is added to the CORS exposedHeaders list so a browser client
    * could read it too, though the browser has the cookie already.
    */
   res.setHeader('X-Session-Token', renewed)
}

/** Guard for routes that require a signed-in customer. */
export const protectCustomer = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const customer = await currentCustomer(req)
      if (!customer) {
         return next(new AppError('Please sign in', 401, SESSION_INVALID))
      }
      ;(req as any).customer = customer
      renewIfStale(req, res)
      next()
   }
)

/* ----------------------------------------------------------------- one-time codes */

/**
 * Codes are stored hashed, exactly like a password. A leaked database dump must
 * not hand over a working login for every customer who happens to have a code
 * outstanding.
 */
export const hashOtp = (code: string) =>
   crypto.createHash('sha256').update(code).digest('hex')

/**
 * The code.
 *
 * Always six random digits, in every environment. There is no fixed demo code
 * and no way to ask the API what it is — a code the server will hand back on
 * request is not a second factor, it is a formality, and leaving that switch in
 * the codebase means it is one environment variable away from being live.
 */
export const generateOtp = () =>
   String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')

/**
 * Delivery. Throws when the provider is unconfigured or refuses.
 *
 * Deliberately no local-console fallback: a request that "succeeds" without an
 * SMS leaves the customer waiting for a code that does not exist, and hides a
 * broken provider until someone tries to sign in for real. Failing loudly at
 * the point of breakage is cheaper than debugging it from the other end.
 */
export const deliverOtp = async (phone: string, code: string) => {
   await sendSms(phone, `${code} is your Flexi Agency verification code. It expires in 5 minutes.`)
}

/* ------------------------------------------------------------------ passwords */

/**
 * Bcrypt, matching the rest of the customer realm (§1.3 keeps Argon2id for the
 * admin). Hashing lives here rather than in a mongoose pre-save hook because
 * every other write to a customer goes through `updateOne`, which skips hooks —
 * a hash that only sometimes happens is a plaintext password waiting to ship.
 */
export const MIN_PASSWORD_LENGTH = 8

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12)

export const verifyPassword = (plain: string, hash?: string) =>
   hash ? bcrypt.compare(plain, hash) : Promise.resolve(false)
