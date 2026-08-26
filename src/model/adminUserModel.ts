import argon2 from 'argon2'
import mongoose, { Schema } from 'mongoose'
import validator from 'validator'

import {
   ADMIN_ROLES,
   LOCKOUT_POLICY,
} from '../constants/admin.constants'
import { IAdminUserDocument } from '../constants/interfaces/IAdminUser'

/**
 * Separate collection from `User` on purpose (§2.1). Admin identities never
 * share a table, a token audience or a signing key with customers.
 */

const sessionSchema = new Schema(
   {
      tokenIdHash: { type: String, required: true },
      ip: { type: String, default: '' },
      userAgent: { type: String, default: '' },
      deviceLabel: { type: String, default: 'Unknown device' },
      createdAt: { type: Date, default: Date.now },
      lastSeenAt: { type: Date, default: Date.now },
      lastStepUpAt: Date,
      revokedAt: Date,
   },
   { _id: true }
)

const adminUserSchema = new Schema<IAdminUserDocument>(
   {
      /** For "send test to me" on the Notifications screen. E.164. */
      phone: { type: String, trim: true },
      email: {
         type: String,
         required: [true, 'Please provide an email'],
         unique: true,
         lowercase: true,
         trim: true,
         validate: [validator.isEmail, 'Please provide a valid email'],
      },
      name: { type: String, required: true, trim: true },
      role: {
         type: String,
         enum: Object.values(ADMIN_ROLES),
         default: ADMIN_ROLES.SUPER_ADMIN,
      },
      password: { type: String, required: true, select: false },
      passwordChangedAt: Date,

      // ponytail: sessions embedded rather than a separate collection — there is
      // one administrator, so this array stays tiny. Split it out if named
      // accounts land (§1.2) and the document starts growing.
      sessions: { type: [sessionSchema], default: [], select: false },

      failedLoginCount: { type: Number, default: 0 },
      lockedUntil: Date,

      isActive: { type: Boolean, default: true },
      enabledAt: Date,
   },
   { timestamps: true }
)

/** Argon2id per §1.3 — bcrypt is used by the customer realm and stays there. */
adminUserSchema.pre('save', async function (next) {
   if (!this.isModified('password')) return next()
   this.password = await argon2.hash(this.password, { type: argon2.argon2id })
   if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000)
   next()
})

adminUserSchema.methods.verifyPassword = async function (candidate: string) {
   // `password` is select:false, so callers must have explicitly selected it.
   if (!this.password) return false
   try {
      return await argon2.verify(this.password, candidate)
   } catch {
      return false
   }
}

adminUserSchema.methods.isLocked = function () {
   return Boolean(this.lockedUntil && this.lockedUntil.getTime() > Date.now())
}

/** Progressive delay rather than a hard lock — the owner must not be able to
 *  permanently lock himself out of his own business (§1.2). */
adminUserSchema.methods.registerFailedLogin = function () {
   this.failedLoginCount += 1
   const over = this.failedLoginCount - LOCKOUT_POLICY.THRESHOLD
   if (over >= 0) {
      const delay = Math.min(
         LOCKOUT_POLICY.BASE_DELAY_MS * 2 ** over,
         LOCKOUT_POLICY.MAX_DELAY_MS
      )
      this.lockedUntil = new Date(Date.now() + delay)
   }
}

const AdminUser = mongoose.model<IAdminUserDocument>(
   'AdminUser',
   adminUserSchema
)

export default AdminUser
