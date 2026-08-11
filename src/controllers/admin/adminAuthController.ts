import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'

import {
   AUDIT_ACTIONS,
   SESSION_POLICY,
} from '../../constants/admin.constants'
import { presentAdminUser, presentSessions } from '../../dto/admin/adminUser.dto'
import { hashTokenId, signAdminToken } from '../../middleware/adminAuth'
import AdminUser from '../../model/adminUserModel'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { validateAdminPassword } from '../../utils/passwordPolicy'
import { sendResponse } from '../../utils/response'

/**
 * Admin authentication: email + password, single step.
 *
 * The guide (§1.3) specifies mandatory TOTP 2FA; the client has decided against
 * it, so the password is the only authentication factor in the system. The
 * consequence, recorded once here: this password is the entire perimeter for an
 * account holding every permission, the customer database and every cost price.
 * §14.1's network isolation (Cloudflare Access + IP allow-list) therefore
 * carries that weight instead of merely adding to it.
 *
 * Still true regardless: no self-registration, and no password reset by email
 * alone (§1.3). The seed script is the only way an admin identity is created.
 */

const deviceLabel = (req: Request) => {
   const ua = req.get('user-agent') || ''
   const os = /Windows|Mac OS|Android|iPhone|iPad|Linux/.exec(ua)?.[0]
   const browser = /Chrome|Firefox|Safari|Edge/.exec(ua)?.[0]
   return [browser, os].filter(Boolean).join(' on ') || 'Unknown device'
}

const issueSession = async (req: Request, admin: any) => {
   const jti = crypto.randomUUID()
   admin.sessions.push({
      tokenIdHash: hashTokenId(jti),
      ip: req.ip || '',
      userAgent: req.get('user-agent') || '',
      deviceLabel: deviceLabel(req),
      createdAt: new Date(),
      lastSeenAt: new Date(),
      // Logging in counts as the step-up for the first few minutes.
      lastStepUpAt: new Date(),
   })
   await admin.save({ validateBeforeSave: false })
   return signAdminToken(admin._id.toString(), jti)
}

export const login = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { email, password } = req.body
      if (!email || !password) {
         return next(new AppError('Email and password are required', 400))
      }

      const admin = await AdminUser.findOne({
         email: String(email).toLowerCase(),
      }).select('+password +sessions')

      // Uniform failure message: never reveal whether the address exists.
      if (!admin) {
         await recordAudit(req, {
            action: AUDIT_ACTIONS.LOGIN_FAILED,
            actorEmail: String(email),
            reason: 'unknown account',
         })
         return next(new AppError('Invalid credentials', 401))
      }

      if (admin.isLocked()) {
         return next(
            new AppError('Too many failed attempts. Try again shortly.', 429)
         )
      }

      if (!admin.isActive) {
         return next(new AppError('Invalid credentials', 401))
      }

      if (!(await admin.verifyPassword(password))) {
         admin.registerFailedLogin()
         await admin.save({ validateBeforeSave: false })
         await recordAudit(req, {
            action: AUDIT_ACTIONS.LOGIN_FAILED,
            actorEmail: admin.email,
            reason: 'bad password',
         })
         return next(new AppError('Invalid credentials', 401))
      }

      admin.failedLoginCount = 0
      admin.lockedUntil = undefined

      const token = await issueSession(req, admin)
      ;(req as any).admin = admin
      await recordAudit(req, { action: AUDIT_ACTIONS.LOGIN_SUCCESS })

      return sendResponse(res, 200, 'Signed in', {
         token,
         expiresIn: SESSION_POLICY.MAX_AGE_MS / 1000,
         admin: presentAdminUser(admin),
      })
   }
)

/**
 * Step-up re-authentication (§1.3), required before settings changes, FX rate
 * changes, payment exceptions, exports and unmasking passport data.
 *
 * Re-entry of the password. The point is that a walked-away-from laptop cannot
 * export the customer database, so this never passes for free.
 */
export const stepUp = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const admin = await AdminUser.findById((req as any).admin._id).select(
         '+password'
      )

      const ok =
         req.body.password &&
         (await admin?.verifyPassword(String(req.body.password)))

      if (!ok) {
         await recordAudit(req, { action: AUDIT_ACTIONS.STEP_UP_FAILED })
         return next(new AppError('Incorrect password', 401))
      }

      const session = (req as any).adminSession
      session.lastStepUpAt = new Date()
      await (req as any).admin.save({ validateBeforeSave: false })

      await recordAudit(req, { action: AUDIT_ACTIONS.STEP_UP_SUCCESS })
      return sendResponse(res, 200, 'Re-authenticated', {
         validForSeconds: SESSION_POLICY.STEP_UP_WINDOW_MS / 1000,
      })
   }
)

export const me = catchAsync(async (req: Request, res: Response) => {
   return sendResponse(res, 200, 'OK', {
      admin: presentAdminUser((req as any).admin),
   })
})

/** §14.1: known devices listed, with one-click revocation of all others. */
export const listSessions = catchAsync(async (req: Request, res: Response) => {
   const admin = (req as any).admin
   const active = admin.sessions.filter((s: any) => !s.revokedAt)
   return sendResponse(res, 200, 'OK', {
      currentSessionId: (req as any).adminSessionId,
      sessions: presentSessions(active),
   })
})

export const revokeOtherSessions = catchAsync(
   async (req: Request, res: Response) => {
      const admin = (req as any).admin
      const currentId = (req as any).adminSessionId
      let revoked = 0
      admin.sessions.forEach((s: any) => {
         if (s._id.toString() !== currentId && !s.revokedAt) {
            s.revokedAt = new Date()
            revoked += 1
         }
      })
      await admin.save({ validateBeforeSave: false })
      await recordAudit(req, {
         action: AUDIT_ACTIONS.SESSIONS_REVOKED,
         reason: `${revoked} session(s) revoked`,
      })
      return sendResponse(res, 200, `${revoked} session(s) signed out`, {
         revoked,
      })
   }
)

export const logout = catchAsync(async (req: Request, res: Response) => {
   const session = (req as any).adminSession
   session.revokedAt = new Date()
   await (req as any).admin.save({ validateBeforeSave: false })
   await recordAudit(req, { action: AUDIT_ACTIONS.LOGOUT })
   return sendResponse(res, 200, 'Signed out', {})
})

export const changePassword = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { currentPassword, newPassword } = req.body
      const admin = await AdminUser.findById((req as any).admin._id).select(
         '+password +sessions'
      )
      if (!admin || !(await admin.verifyPassword(currentPassword))) {
         return next(new AppError('Current password is incorrect', 401))
      }

      const problem = await validateAdminPassword(newPassword)
      if (problem) return next(new AppError(problem, 400))

      admin.password = newPassword
      // Changing the password signs every device out, including this one.
      admin.sessions.forEach((s: any) => {
         if (!s.revokedAt) s.revokedAt = new Date()
      })
      await admin.save()

      await recordAudit(req, { action: AUDIT_ACTIONS.PASSWORD_CHANGED })
      return sendResponse(res, 200, 'Password changed. Please sign in again.', {})
   }
)
