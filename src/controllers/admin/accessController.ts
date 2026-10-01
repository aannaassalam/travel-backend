import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import mongoose from 'mongoose'
import validator from 'validator'

import {
   ADMIN_ROLES,
   AUDIT_ACTIONS,
   PASSWORD_POLICY,
   PERMISSIONS,
} from '../../constants/admin.constants'
import { IAdminUserDocument } from '../../constants/interfaces/IAdminUser'
import { presentAccessRole, presentAccessUser } from '../../dto/admin/adminUser.dto'
import { isSubset, resolveAccess, roleNameFor } from '../../middleware/adminAuth'
import AccessRole, { ROLE_NAME_COLLATION } from '../../model/accessRoleModel'
import AdminUser from '../../model/adminUserModel'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendEmail } from '../../utils/email_sms'
import { sendResponse } from '../../utils/response'

/**
 * Who can do what: admin-panel users and the roles they hold.
 *
 * The route table only proves the caller holds users:write or roles:write.
 * Everything that stops those two permissions from becoming "every permission"
 * lives here, server-side — the UI hiding a button is not a control.
 *
 * The rules, in one place:
 *   - nobody changes their own account or their own role through these routes;
 *   - only a SUPER_ADMIN creates, assigns or touches a SUPER_ADMIN;
 *   - BREAK_GLASS accounts exist only through the seed script;
 *   - everyone else can only hand out, edit or act on access that is a subset
 *     of what they hold themselves.
 */

// ===========================================================================
// Rules — pure, so `npm run check:rbac` can exercise them without a database
// ===========================================================================

export interface Actor {
   id: string
   isSuper: boolean
   roleId?: string
   permissions: readonly string[]
}

const REFUSALS = {
   SELF_MODIFY: ['You cannot change your own account here', 403],
   FORBIDDEN_TARGET: ['You are not allowed to manage this kind of account', 403],
   ROLE_EXCEEDS_GRANTOR: ['That access is greater than your own', 403],
   OWN_ROLE: ['You cannot change the role you hold yourself', 403],
   LAST_SUPER_ADMIN: ['The last active super admin cannot be removed', 409],
   ROLE_IN_USE: ['This role is still assigned to users', 409],
   EMAIL_TAKEN: ['An admin user with that email already exists', 409],
   ROLE_NAME_TAKEN: ['A role with that name already exists', 409],
} as const

type RefusalCode = keyof typeof REFUSALS

const refuse = (code: RefusalCode) =>
   new AppError(REFUSALS[code][0], REFUSALS[code][1], code)

/** R4/R5: a non-super actor only deals in permissions they hold themselves. */
export const canGrant = (actor: Actor, permissions: readonly string[]) =>
   actor.isSuper || isSubset(permissions, actor.permissions)

/** R2/R3: which account kinds the actor may create or assign. */
export const kindRefusal = (actor: Actor, kind: unknown): RefusalCode | null => {
   if (kind === ADMIN_ROLES.BREAK_GLASS) return 'FORBIDDEN_TARGET'
   if (kind === ADMIN_ROLES.SUPER_ADMIN && !actor.isSuper) return 'FORBIDDEN_TARGET'
   return null
}

/**
 * R1–R4: may the actor modify, deactivate, reactivate or reset this user?
 *
 * The subset rule applies to the target as well as to the role being handed
 * out: a password reset gives the actor a working credential for the target,
 * so without it users:write would be a takeover path to any stronger account.
 */
export const targetRefusal = (
   actor: Actor,
   target: { id: string; role: string; permissions: readonly string[] }
): RefusalCode | null => {
   if (target.id === actor.id) return 'SELF_MODIFY'
   if (target.role === ADMIN_ROLES.BREAK_GLASS) return 'FORBIDDEN_TARGET'
   if (actor.isSuper) return null
   if (target.role === ADMIN_ROLES.SUPER_ADMIN) return 'FORBIDDEN_TARGET'
   if (!isSubset(target.permissions, actor.permissions)) return 'ROLE_EXCEEDS_GRANTOR'
   return null
}

/** R5: may the actor edit or delete this role as it stands today? */
export const roleEditRefusal = (
   actor: Actor,
   role: { id: string; permissions: readonly string[] }
): RefusalCode | null => {
   if (actor.isSuper) return null
   if (actor.roleId === role.id) return 'OWN_ROLE'
   if (!isSubset(role.permissions, actor.permissions)) return 'ROLE_EXCEEDS_GRANTOR'
   return null
}

/** R6: does this change take an active super admin out of service? */
export const losesActiveSuper = (
   before: { role: string; isActive: boolean },
   after: { role: string; isActive: boolean }
) =>
   before.role === ADMIN_ROLES.SUPER_ADMIN &&
   before.isActive &&
   !(after.role === ADMIN_ROLES.SUPER_ADMIN && after.isActive)

/** The account kinds and their display labels cannot be used as role names. */
const RESERVED_ROLE_NAMES: string[] = Object.values(ADMIN_ROLES)

/**
 * R7: role input. Returns only the fields that were supplied, cleaned; throws
 * a 400 on anything else. An unknown permission is refused, never dropped —
 * a silently shortened list would save a role that is not the one on screen.
 */
export const parseRoleInput = (body: any, requireAll: boolean) => {
   const out: { name?: string; description?: string; permissions?: string[] } = {}

   if (requireAll || body?.name !== undefined) {
      // Folded and allow-listed before anything compares it: an invisible or
      // look-alike character would otherwise walk past both the reserved-name
      // check and the uniqueness check, and a staff role could be made to
      // display as "Super admin".
      const name =
         typeof body?.name === 'string'
            ? body.name.normalize('NFKC').replace(/\s+/g, ' ').trim()
            : ''
      if (!name || name.length > 60 || !/^[\p{Script=Latin}\p{Nd} &/().'-]+$/u.test(name)) {
         throw new AppError(
            "Role name must be 1 to 60 letters, digits, spaces or & / ( ) . ' -",
            400
         )
      }
      if (RESERVED_ROLE_NAMES.includes(name.toUpperCase().replace(/[\s-]+/g, '_'))) {
         throw new AppError('That role name is reserved', 400)
      }
      out.name = name
   }

   if (body?.description !== undefined) {
      const description =
         typeof body.description === 'string' ? body.description.trim() : null
      if (description === null || description.length > 300) {
         throw new AppError('Description must be at most 300 characters', 400)
      }
      out.description = description
   }

   if (requireAll || body?.permissions !== undefined) {
      const list = body?.permissions
      if (
         !Array.isArray(list) ||
         list.some((p) => !(PERMISSIONS as readonly string[]).includes(p))
      ) {
         throw new AppError('permissions must be a list of known permissions', 400)
      }
      // Filtering the catalogue removes duplicates and gives a stable order.
      out.permissions = PERMISSIONS.filter((p) => list.includes(p))
   }

   return out
}

// ===========================================================================
// Shared helpers
// ===========================================================================

const MAX_USERS = 200
const MAX_ROLES = 200

const actorOf = (req: Request): Actor => {
   const admin = (req as any).admin
   return {
      id: admin._id.toString(),
      isSuper: admin.role === ADMIN_ROLES.SUPER_ADMIN,
      roleId: admin.roleId?.toString(),
      permissions: (req as any).adminAccess?.permissions ?? [],
   }
}

/** Body values are untrusted: a string, and a well-formed id. */
const validId = (value: unknown): value is string =>
   typeof value === 'string' && mongoose.isValidObjectId(value)

/** R10: the only fields that ever reach the audit log from here. */
const userAudit = (u: IAdminUserDocument) => ({
   name: u.name,
   email: u.email,
   role: u.role,
   roleId: u.roleId?.toString() ?? null,
   isActive: u.isActive,
})

const roleAudit = (r: { name: string; permissions: string[] }) => ({
   name: r.name,
   permissions: [...r.permissions],
})

const cleanName = (value: unknown) => {
   const name = typeof value === 'string' ? value.trim() : ''
   if (!name || name.length > 100) {
      throw new AppError('Name must be 1 to 100 characters', 400)
   }
   return name
}

/** E.164, as the model expects. Empty clears it. */
const cleanPhone = (value: unknown) => {
   if (value === undefined || value === null || value === '') return undefined
   const phone = typeof value === 'string' ? value.replace(/\s+/g, '') : ''
   if (!/^\+?[1-9]\d{6,14}$/.test(phone)) {
      throw new AppError(
         'Phone must be in international format, for example +243812345678',
         400
      )
   }
   return phone
}

const loadRole = async (id: unknown) => {
   if (!validId(id)) throw new AppError('Invalid role id', 400)
   const role = await AccessRole.findById(id)
   if (!role) throw new AppError('Role not found', 404)
   return role
}

/** R8 + R4: a STAFF user must point at a real role the actor may hand out. */
const loadAssignableRole = async (actor: Actor, roleId: unknown) => {
   if (!validId(roleId)) {
      throw new AppError('A valid roleId is required for a STAFF user', 400)
   }
   const role = await AccessRole.findById(roleId)
   if (!role) throw new AppError('Role not found', 400)
   if (!canGrant(actor, role.permissions)) throw refuse('ROLE_EXCEEDS_GRANTOR')
   return role
}

/** Loads the user being acted on, or throws — R1 to R4 are applied here. */
const loadTarget = async (actor: Actor, id: unknown) => {
   if (!validId(id)) throw new AppError('Invalid user id', 400)
   const target = await AdminUser.findById(id).select('+sessions')
   if (!target) throw new AppError('User not found', 404)

   const { permissions } = await resolveAccess(target)
   const refusal = targetRefusal(actor, {
      id: target._id.toString(),
      role: target.role,
      permissions,
   })
   if (refusal) throw refuse(refusal)
   return target
}

const roleNameTaken = (name: string, exceptId?: string) =>
   AccessRole.exists({
      name,
      ...(exceptId && { _id: { $ne: exceptId } }),
   }).collation(ROLE_NAME_COLLATION)

/** R11. Saved by the caller, in the same write as the change that needs it. */
const revokeSessions = (user: IAdminUserDocument) =>
   user.sessions.forEach((s: any) => {
      if (!s.revokedAt) s.revokedAt = new Date()
   })

/**
 * 18 random bytes, 24 base64url characters — comfortably above the 14-character
 * floor. It exists in plaintext only in the response and the email below: the
 * model hashes it on save, and it is never logged or audited.
 */
const generateTemporaryPassword = () =>
   crypto.randomBytes(18).toString('base64url')

const temporaryPasswordExpiry = () =>
   new Date(Date.now() + PASSWORD_POLICY.TEMP_PASSWORD_TTL_MS)

/**
 * Without a mail transport the legacy sender still tries Gmail with no
 * credentials, which costs the request several seconds and can never succeed.
 */
const emailConfigured = () =>
   Boolean(
      (process.env.AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING &&
         process.env.AZURE_SENDER_EMAIL) ||
         (process.env.EMAIL_USERNAME && process.env.EMAIL_PASSWORD)
   )

/**
 * Best effort. `true` only when the send resolved, so the person who created
 * the account knows whether they still have to pass the password on themselves.
 */
const emailTemporaryPassword = async (email: string, temporaryPassword: string) => {
   if (!emailConfigured()) return false
   try {
      await sendEmail({
         email,
         subject: 'Your admin panel access',
         html:
            '<p>An administrator has given you access to the admin panel, or reset your password.</p>' +
            `<p>Your temporary password is: <strong>${temporaryPassword}</strong></p>` +
            '<p>It works for 72 hours. You will be asked to choose a new password when you sign in. ' +
            'If you were not expecting this message, tell your administrator.</p>',
      })
      return true
   } catch {
      // Deliberately not logged: nothing about this send belongs in a log.
      return false
   }
}

// ===========================================================================
// Roles
// ===========================================================================

export const listRoles = catchAsync(async (_req: Request, res: Response) => {
   const [roles, counts] = await Promise.all([
      AccessRole.find().sort({ name: 1 }).limit(MAX_ROLES),
      AdminUser.aggregate([
         { $match: { roleId: { $ne: null } } },
         { $group: { _id: '$roleId', n: { $sum: 1 } } },
      ]),
   ])
   const byRole = new Map(counts.map((c: any) => [String(c._id), c.n]))

   return sendResponse(res, 200, 'OK', {
      roles: roles.map((r) => presentAccessRole(r, byRole.get(r._id.toString()) ?? 0)),
      catalogue: PERMISSIONS,
   })
})

export const createRole = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const actor = actorOf(req)
      const input = parseRoleInput(req.body, true)

      if (!canGrant(actor, input.permissions!)) {
         return next(refuse('ROLE_EXCEEDS_GRANTOR'))
      }
      if (await roleNameTaken(input.name!)) return next(refuse('ROLE_NAME_TAKEN'))

      // Built field by field: req.body never reaches the model.
      const role = await AccessRole.create({
         name: input.name,
         description: input.description ?? '',
         permissions: input.permissions,
      })

      await recordAudit(req, {
         action: AUDIT_ACTIONS.ADMIN_ACCESS_CHANGED,
         entityType: 'AccessRole',
         entityId: role._id.toString(),
         after: roleAudit(role),
         reason: 'role created',
      })
      return sendResponse(res, 201, 'Role created', {
         role: presentAccessRole(role, 0),
      })
   }
)

export const updateRole = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const actor = actorOf(req)
      const role = await loadRole(req.params.id)
      const roleId = role._id.toString()

      // Judged on the role as it stands, before looking at the requested change.
      const refusal = roleEditRefusal(actor, { id: roleId, permissions: role.permissions })
      if (refusal) return next(refuse(refusal))

      const input = parseRoleInput(req.body, false)
      if (input.permissions && !canGrant(actor, input.permissions)) {
         return next(refuse('ROLE_EXCEEDS_GRANTOR'))
      }
      if (input.name && (await roleNameTaken(input.name, roleId))) {
         return next(refuse('ROLE_NAME_TAKEN'))
      }

      const before = roleAudit(role)
      if (input.name !== undefined) role.name = input.name
      if (input.description !== undefined) role.description = input.description
      if (input.permissions !== undefined) role.permissions = input.permissions
      await role.save()

      /**
       * A role that just gained access takes its holders up with it. Anyone
       * still on a temporary password shares that password with whoever issued
       * it — possibly someone who could not have granted the new access — so
       * those temporary passwords stop working and have to be issued again.
       */
      if (!isSubset(role.permissions, before.permissions)) {
         await AdminUser.updateMany(
            { roleId: role._id, mustChangePassword: true },
            { $set: { temporaryPasswordExpiresAt: new Date(0) } }
         )
      }

      const after = roleAudit(role)
      await recordAudit(req, {
         action: AUDIT_ACTIONS.ADMIN_ACCESS_CHANGED,
         entityType: 'AccessRole',
         entityId: roleId,
         before,
         after,
         reason:
            String(before.permissions) !== String(after.permissions)
               ? 'role permissions changed'
               : 'role updated',
      })
      // No sessions to revoke: permissions are resolved on every request.
      return sendResponse(res, 200, 'Role saved', {
         role: presentAccessRole(
            role,
            await AdminUser.countDocuments({ roleId: role._id })
         ),
      })
   }
)

export const deleteRole = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const actor = actorOf(req)
      const role = await loadRole(req.params.id)
      const roleId = role._id.toString()

      const refusal = roleEditRefusal(actor, { id: roleId, permissions: role.permissions })
      if (refusal) return next(refuse(refusal))

      if (await AdminUser.exists({ roleId: role._id })) {
         return next(refuse('ROLE_IN_USE'))
      }

      // A user assigned between the check above and this delete is left holding
      // a role that no longer exists — which resolves to no permissions.
      await role.deleteOne()

      await recordAudit(req, {
         action: AUDIT_ACTIONS.ADMIN_ACCESS_CHANGED,
         entityType: 'AccessRole',
         entityId: roleId,
         before: roleAudit(role),
         reason: 'role deleted',
      })
      return sendResponse(res, 200, 'Role deleted', {})
   }
)

// ===========================================================================
// Users (admin-panel users, not customers)
// ===========================================================================

export const listUsers = catchAsync(async (_req: Request, res: Response) => {
   const users = await AdminUser.find().sort({ _id: -1 }).limit(MAX_USERS)
   const roles = await AccessRole.find({
      _id: { $in: users.map((u) => u.roleId).filter(Boolean) },
   })
   const byId = new Map(roles.map((r) => [r._id.toString(), r]))

   return sendResponse(res, 200, 'OK', {
      users: users.map((u) =>
         presentAccessUser(u, roleNameFor(u.role, byId.get(String(u.roleId))))
      ),
   })
})

/** Only what the caller could actually assign, so the form cannot offer more. */
export const assignableRoles = catchAsync(async (req: Request, res: Response) => {
   const actor = actorOf(req)
   const roles = await AccessRole.find().sort({ name: 1 }).limit(MAX_ROLES)

   return sendResponse(res, 200, 'OK', {
      roles: roles
         .filter((r) => canGrant(actor, r.permissions))
         .map((r) => ({
            id: r._id.toString(),
            name: r.name,
            permissions: [...r.permissions],
         })),
      canAssignSuperAdmin: actor.isSuper,
   })
})

export const createUser = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const actor = actorOf(req)
      const body = req.body ?? {}

      const name = cleanName(body.name)
      const phone = cleanPhone(body.phone)
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      // Printable ASCII only — see the model for why.
      if (!/^[\x21-\x7e]+$/.test(email) || !validator.isEmail(email)) {
         return next(new AppError('A valid email is required', 400))
      }

      const kind = body.role
      const refusal = kindRefusal(actor, kind)
      if (refusal) return next(refuse(refusal))
      if (kind !== ADMIN_ROLES.STAFF && kind !== ADMIN_ROLES.SUPER_ADMIN) {
         return next(new AppError('role must be STAFF or SUPER_ADMIN', 400))
      }
      // A SUPER_ADMIN carries no role; whatever roleId was sent is ignored.
      const role =
         kind === ADMIN_ROLES.STAFF
            ? await loadAssignableRole(actor, body.roleId)
            : null

      if (await AdminUser.exists({ email })) return next(refuse('EMAIL_TAKEN'))

      const temporaryPassword = generateTemporaryPassword()
      // save(), not an update: the pre-save hook is what hashes the password.
      const user = new AdminUser({
         name,
         email,
         phone,
         role: kind,
         roleId: role?._id,
         password: temporaryPassword,
         mustChangePassword: true,
         temporaryPasswordExpiresAt: temporaryPasswordExpiry(),
         isActive: true,
      })
      await user.save()

      await recordAudit(req, {
         action: AUDIT_ACTIONS.ADMIN_ACCESS_CHANGED,
         entityType: 'AdminUser',
         entityId: user._id.toString(),
         after: userAudit(user),
         reason: 'user created',
      })

      const emailed = await emailTemporaryPassword(email, temporaryPassword)
      return sendResponse(res, 201, 'User created', {
         user: presentAccessUser(user, roleNameFor(kind, role)),
         // Shown once. It cannot be retrieved again, only reset.
         temporaryPassword,
         expiresAt: user.temporaryPasswordExpiresAt,
         emailed,
      })
   }
)

export const updateUser = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const actor = actorOf(req)
      const target = await loadTarget(actor, req.params.id)
      const body = req.body ?? {}
      const before = userAudit(target)

      // Explicit allow-list. Email is not editable after creation.
      if (body.name !== undefined) target.name = cleanName(body.name)
      if (body.phone !== undefined) target.phone = cleanPhone(body.phone)
      if (body.isActive !== undefined) {
         if (typeof body.isActive !== 'boolean') {
            return next(new AppError('isActive must be true or false', 400))
         }
         target.isActive = body.isActive
      }

      if (body.role !== undefined || body.roleId !== undefined) {
         const kind = body.role ?? target.role
         const refusal = kindRefusal(actor, kind)
         if (refusal) return next(refuse(refusal))
         if (kind !== ADMIN_ROLES.STAFF && kind !== ADMIN_ROLES.SUPER_ADMIN) {
            return next(new AppError('role must be STAFF or SUPER_ADMIN', 400))
         }
         target.role = kind
         target.roleId =
            kind === ADMIN_ROLES.STAFF
               ? (
                    await loadAssignableRole(
                       actor,
                       body.roleId ?? target.roleId?.toString()
                    )
                 )._id
               : undefined
      }

      if (!target.isModified()) {
         return sendResponse(res, 200, 'Nothing to change', {
            user: presentAccessUser(target, (await resolveAccess(target)).roleName),
         })
      }

      const after = userAudit(target)

      /**
       * R6. R1 and R2 already mean the actor is a second active super admin, so
       * this should be unreachable — it is kept as its own check so the
       * guarantee does not depend on two other rules staying as they are.
       *
       * ponytail: check-then-write, not atomic. Two super admins demoting each
       * other in the same instant could both pass; seeding a fresh SUPER_ADMIN
       * recovers. Use a transaction if that ever matters.
       */
      if (losesActiveSuper(before, after)) {
         const others = await AdminUser.countDocuments({
            _id: { $ne: target._id },
            role: ADMIN_ROLES.SUPER_ADMIN,
            isActive: true,
         })
         if (others === 0) return next(refuse('LAST_SUPER_ADMIN'))
      }

      // R11: a deactivated account keeps no live session to come back to.
      if (before.isActive && !after.isActive) revokeSessions(target)

      /**
       * Changing the access of an account that is still on its temporary
       * password cancels that password. Whoever issued it knows it, and they
       * may not have been allowed to grant what the account holds now.
       */
      const temporaryPasswordCancelled =
         target.mustChangePassword &&
         (target.isModified('role') || target.isModified('roleId'))
      if (temporaryPasswordCancelled) {
         target.temporaryPasswordExpiresAt = new Date(0)
         revokeSessions(target)
      }

      // Versioned, so this and a simultaneous password change cannot silently
      // overwrite each other.
      target.increment()
      await target.save()

      await recordAudit(req, {
         action: AUDIT_ACTIONS.ADMIN_ACCESS_CHANGED,
         entityType: 'AdminUser',
         entityId: target._id.toString(),
         before,
         after,
         reason:
            before.isActive !== after.isActive
               ? after.isActive
                  ? 'user reactivated'
                  : 'user deactivated'
               : before.role !== after.role || before.roleId !== after.roleId
                 ? 'user role changed'
                 : 'user updated',
      })
      return sendResponse(res, 200, 'User saved', {
         user: presentAccessUser(target, (await resolveAccess(target)).roleName),
         // The caller must reset the password to give the user a way in.
         temporaryPasswordCancelled,
      })
   }
)

/**
 * Issues a new temporary password. Own password changes go through
 * PATCH /auth/password, which asks for the current one — this route cannot be
 * used on yourself (R1).
 */
export const resetUserPassword = catchAsync(async (req: Request, res: Response) => {
   const actor = actorOf(req)
   const target = await loadTarget(actor, req.params.id)

   const temporaryPassword = generateTemporaryPassword()
   target.password = temporaryPassword
   target.mustChangePassword = true
   target.temporaryPasswordExpiresAt = temporaryPasswordExpiry()
   // A reset is usually for someone locked out; the delay belonged to the old password.
   target.failedLoginCount = 0
   target.lockedUntil = undefined
   revokeSessions(target)
   target.increment()
   await target.save()

   await recordAudit(req, {
      action: AUDIT_ACTIONS.ADMIN_ACCESS_CHANGED,
      entityType: 'AdminUser',
      entityId: target._id.toString(),
      reason: 'password reset',
   })

   const emailed = await emailTemporaryPassword(target.email, temporaryPassword)
   return sendResponse(res, 200, 'Password reset', {
      temporaryPassword,
      expiresAt: target.temporaryPasswordExpiresAt,
      emailed,
   })
})
