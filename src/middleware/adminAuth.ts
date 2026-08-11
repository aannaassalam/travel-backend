import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'

import {
   ADMIN_ROLES,
   ADMIN_TOKEN_AUDIENCE,
   AUDIT_ACTIONS,
   SESSION_POLICY,
} from '../constants/admin.constants'
import AdminUser from '../model/adminUserModel'
import { recordAudit } from '../services/auditLog.service'
import AppError from '../utils/appError'
import catchAsync from '../utils/catchAsync'

/**
 * §1.3: distinct signing key. A customer token must be structurally incapable
 * of reaching /admin/v1 — not merely rejected by a role check, but unverifiable
 * here at all. With one all-powerful account this is the most important
 * boundary in the system.
 */
export const adminJwtSecret = () => {
   const secret = process.env.ADMIN_JWT_SECRET
   if (!secret) {
      throw new Error('ADMIN_JWT_SECRET is not defined')
   }
   if (secret === process.env.JWT_SECRET) {
      throw new Error(
         'ADMIN_JWT_SECRET must differ from the customer JWT_SECRET (guide §1.3)'
      )
   }
   return secret
}

export const hashTokenId = (jti: string) =>
   crypto.createHash('sha256').update(jti).digest('hex')

export const signAdminToken = (adminId: string, jti: string) =>
   jwt.sign({ sub: adminId, jti }, adminJwtSecret(), {
      audience: ADMIN_TOKEN_AUDIENCE,
      expiresIn: SESSION_POLICY.MAX_AGE_MS / 1000,
   })

/** Guard for every /admin/v1 route. */
export const protectAdmin = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const header = req.headers.authorization
      const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
      if (!token) {
         return next(new AppError('You are not logged in', 401))
      }

      let decoded: any
      try {
         decoded = jwt.verify(token, adminJwtSecret(), {
            audience: ADMIN_TOKEN_AUDIENCE,
         })
      } catch {
         return next(new AppError('Invalid or expired session', 401))
      }

      const admin = await AdminUser.findById(decoded.sub).select(
         '+sessions'
      )
      if (!admin || !admin.isActive) {
         return next(new AppError('Account is not active', 401))
      }

      const session = admin.sessions.find(
         (s: any) => s.tokenIdHash === hashTokenId(decoded.jti)
      ) as any
      if (!session || session.revokedAt) {
         return next(new AppError('Session has been revoked', 401))
      }

      // §1.3: 30-minute idle timeout, on top of the token's 8h absolute expiry.
      const idleFor = Date.now() - new Date(session.lastSeenAt).getTime()
      if (idleFor > SESSION_POLICY.IDLE_TIMEOUT_MS) {
         session.revokedAt = new Date()
         await admin.save({ validateBeforeSave: false })
         return next(new AppError('Session expired through inactivity', 401))
      }

      if (admin.passwordChangedAt && decoded.iat) {
         const changedAt = admin.passwordChangedAt.getTime() / 1000
         if (decoded.iat < changedAt) {
            return next(new AppError('Password changed, please log in again', 401))
         }
      }

      session.lastSeenAt = new Date()
      await admin.save({ validateBeforeSave: false })

      ;(req as any).admin = admin
      ;(req as any).adminSession = session
      ;(req as any).adminSessionId = session._id.toString()
      next()
   }
)

/**
 * §1.1: permission checks route through one central guard even though it always
 * passes for the single role today. Introducing named accounts later becomes a
 * data change plus a UI addition, not a refactor through every controller.
 */
export const requirePermission =
   (_permission: string) =>
   (req: Request, res: Response, next: NextFunction) => {
      const admin = (req as any).admin
      if (!admin) return next(new AppError('You are not logged in', 401))
      if (admin.role === ADMIN_ROLES.SUPER_ADMIN) return next()
      if (admin.role === ADMIN_ROLES.BREAK_GLASS) return next()
      return next(new AppError('Insufficient permissions', 403))
   }

/**
 * §1.3: step-up re-authentication for settings changes, FX rates, payment
 * exceptions, exports and unmasked passport data.
 */
export const requireStepUp = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const session = (req as any).adminSession
      const last = session?.lastStepUpAt
      const fresh =
         last && Date.now() - new Date(last).getTime() < SESSION_POLICY.STEP_UP_WINDOW_MS

      if (!fresh) {
         await recordAudit(req, { action: AUDIT_ACTIONS.STEP_UP_FAILED })
         return next(
            new AppError('Re-authentication required for this action', 403)
         )
      }
      next()
   }
)

/**
 * §2.2: no endpoint returns unbounded results. Hard maximum page size on every
 * list, applied centrally so no future controller can forget.
 */
export const MAX_PAGE_SIZE = 100

export const boundPagination = (
   req: Request,
   res: Response,
   next: NextFunction
) => {
   const requested = Number(req.query.limit) || 25
   req.query.limit = String(Math.min(Math.max(requested, 1), MAX_PAGE_SIZE))
   next()
}
