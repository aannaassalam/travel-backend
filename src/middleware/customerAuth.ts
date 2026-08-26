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

const customerJwtSecret = () => {
   const secret = process.env.JWT_SECRET
   if (!secret) throw new Error('JWT_SECRET is not defined')
   return secret
}

export const signCustomerToken = (customerId: string) =>
   jwt.sign({ sub: customerId }, customerJwtSecret(), {
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
      return customer
   } catch {
      return null
   }
}

/** Guard for routes that require a signed-in customer. */
export const protectCustomer = catchAsync(
   async (req: Request, _res: Response, next: NextFunction) => {
      const customer = await currentCustomer(req)
      if (!customer) {
         return next(new AppError('Please sign in', 401, SESSION_INVALID))
      }
      ;(req as any).customer = customer
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
