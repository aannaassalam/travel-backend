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
         // Printable ASCII only. A look-alike or invisible character would let
         // one account display exactly like another in the audit log.
         validate: [
            (v: string) => /^[\x21-\x7e]+$/.test(v) && validator.isEmail(v),
            'Please provide a valid email',
         ],
      },
      name: { type: String, required: true, trim: true },
      /**
       * The account KIND. Defaults to STAFF so the schema fails closed: an
       * account created without an explicit kind holds no permissions, and can
       * never come into existence as a super admin by omission.
       */
      role: {
         type: String,
         enum: Object.values(ADMIN_ROLES),
         default: ADMIN_ROLES.STAFF,
      },
      /** The one AccessRole a STAFF account holds. Unused by the other kinds. */
      roleId: { type: Schema.Types.ObjectId, ref: 'AccessRole' },
      password: { type: String, required: true, select: false },
      passwordChangedAt: Date,
      /** Set while the password is a system-generated temporary one. */
      mustChangePassword: { type: Boolean, default: false },
      /** After this the temporary password no longer signs in. */
      temporaryPasswordExpiresAt: Date,
      /**
       * Hash of the last temporary password issued. Whoever issued it still
       * knows it, so the account must never be set back to it.
       */
      temporaryPasswordHash: { type: String, select: false },
      lastLoginAt: Date,

      // ponytail: sessions embedded rather than a separate collection — each
      // account carries only its own, so this array stays tiny. Split it out
      // if a document starts growing.
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
   if (this.mustChangePassword) this.temporaryPasswordHash = this.password
   if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000)
   next()
})

adminUserSchema.methods.verifyPassword = async function (candidate: string) {
   // `password` is select:false, so callers must have explicitly selected it.
   // A string only: argon2 also accepts a byte array, which would let a caller
   // slip past every `===` comparison made on the request body.
   if (!this.password || typeof candidate !== 'string') return false
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
