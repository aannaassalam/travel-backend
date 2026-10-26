import { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { Driver } from '../model/driverModel'
import AppError from '../utils/appError'
import catchAsync from '../utils/catchAsync'
import { SESSION_INVALID } from './customerAuth'

/**
 * Driver sessions for the driver portal (website, /driver).
 *
 * Modelled on customerAuth: its own cookie and its own audience, so a customer
 * token cannot pass as a driver's nor the reverse — the audience check alone
 * guarantees that even when DRIVER_JWT_SECRET is left unset and the customer
 * secret is used. The window slides like the customer's: a driver who works
 * every day is never signed out.
 */

export const DRIVER_COOKIE = 'drv_session'
export const DRIVER_AUDIENCE = 'driver'
/** For a client that cannot hold the cookie; also how a renewed token is handed back. */
export const DRIVER_TOKEN_HEADER = 'X-Driver-Token'
export const DRIVER_SESSION_MS = Number(process.env.DRIVER_SESSION_DAYS || 7) * 86400_000
/** Renew once the token is older than this, not on every request. */
const REFRESH_AFTER_MS = 86400_000
/** `lastSeenAt` is a courtesy figure for the office; one write every few minutes is plenty. */
const SEEN_EVERY_MS = 5 * 60_000

const driverJwtSecret = () => {
   const secret = process.env.DRIVER_JWT_SECRET || process.env.JWT_SECRET
   if (!secret) throw new Error('DRIVER_JWT_SECRET (or JWT_SECRET) is not defined')
   return secret
}

export const signDriverToken = (driverId: string) =>
   jwt.sign({ sub: driverId }, driverJwtSecret(), {
      audience: DRIVER_AUDIENCE,
      expiresIn: DRIVER_SESSION_MS / 1000,
   })

// Same attributes as the customer cookie, for the same reasons (see customerAuth).
const cookieOptions = () => {
   const crossSite = process.env.NODE_ENV === 'production'
   return {
      httpOnly: true,
      sameSite: crossSite ? ('none' as const) : ('lax' as const),
      secure: crossSite,
      path: '/',
   }
}

export const setDriverCookie = (res: Response, token: string) =>
   res.cookie(DRIVER_COOKIE, token, { ...cookieOptions(), maxAge: DRIVER_SESSION_MS })

export const clearDriverCookie = (res: Response) => res.clearCookie(DRIVER_COOKIE, cookieOptions())

const readToken = (req: Request) =>
   (req.header(DRIVER_TOKEN_HEADER) as string | undefined) || ((req as any).cookies?.[DRIVER_COOKIE] as string | undefined)

/** The signed-in driver, or null. Never throws. */
export const currentDriver = async (req: Request) => {
   const token = readToken(req)
   if (!token) return null
   try {
      const decoded: any = jwt.verify(token, driverJwtSecret(), { audience: DRIVER_AUDIENCE })
      const driver = await Driver.findById(decoded.sub)
      if (!driver || !driver.isActive) return null
      // A password set by the office ends every session opened before it, and
      // so does a logout: a phone the driver no longer holds stays signed out.
      const issued = decoded.iat ? decoded.iat * 1000 : 0
      const changedAt = driver.passwordChangedAt?.getTime()
      if (changedAt && issued && issued < changedAt) return null
      const validFrom = driver.tokensValidFrom?.getTime()
      if (validFrom && issued && issued < validFrom) return null
      ;(req as any).driverToken = decoded
      return driver
   } catch {
      return null
   }
}

const renewIfStale = (req: Request, res: Response) => {
   const decoded: any = (req as any).driverToken
   const issuedAt = decoded?.iat ? decoded.iat * 1000 : 0
   if (!issuedAt || Date.now() - issuedAt < REFRESH_AFTER_MS) return
   const renewed = signDriverToken(String(decoded.sub))
   setDriverCookie(res, renewed)
   res.setHeader(DRIVER_TOKEN_HEADER, renewed)
}

/** Guard for the driver routes. */
export const protectDriver = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
   const driver = await currentDriver(req)
   if (!driver) return next(new AppError('Please sign in', 401, SESSION_INVALID))
   ;(req as any).driver = driver
   renewIfStale(req, res)
   if (!driver.lastSeenAt || Date.now() - driver.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      // Not awaited and never fatal: a bookkeeping write must not slow a ride.
      void Driver.updateOne({ _id: driver._id }, { $set: { lastSeenAt: new Date() } }, { timestamps: false }).catch(() => undefined)
   }
   next()
})
