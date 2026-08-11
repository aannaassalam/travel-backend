import { Document, Types } from 'mongoose'
import { AdminRole } from '../admin.constants'

/** A logged-in device/session. Revocable individually or in bulk (§14.1). */
export interface IAdminSession {
   _id: Types.ObjectId
   /** SHA-256 of the JWT id — the raw jti is never stored. */
   tokenIdHash: string
   ip: string
   userAgent: string
   deviceLabel: string
   createdAt: Date
   lastSeenAt: Date
   /** Set when this session last passed step-up re-auth (§1.3). */
   lastStepUpAt?: Date
   revokedAt?: Date
}

export interface IAdminUserDocument extends Document {
   _id: Types.ObjectId
   email: string
   name: string
   role: AdminRole
   password: string
   passwordChangedAt?: Date

   sessions: Types.DocumentArray<IAdminSession & Document>

   failedLoginCount: number
   lockedUntil?: Date

   /** Break-glass accounts are disabled until the sealed procedure runs (§1.2). */
   isActive: boolean
   enabledAt?: Date

   createdAt: Date
   updatedAt: Date

   verifyPassword(candidate: string): Promise<boolean>
   isLocked(): boolean
   registerFailedLogin(): void
}
