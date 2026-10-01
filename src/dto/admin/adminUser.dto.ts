import { IAdminUserDocument } from '../../constants/interfaces/IAdminUser'
import { IAdminSession } from '../../constants/interfaces/IAdminUser'
import { IAccessRoleDocument } from '../../model/accessRoleModel'
import { FieldMap, present, presentList } from '../../utils/present'

/**
 * Admin-surface DTOs. §14.3 rule 2: these are never imported by anything under
 * routes/v1 — no shared DTOs between admin and public surfaces, ever.
 *
 * Note what is absent and must stay absent: password and tokenIdHash.
 */

const adminUserFields: FieldMap<IAdminUserDocument> = {
   id: (a) => a._id.toString(),
   email: (a) => a.email,
   name: (a) => a.name,
   role: (a) => a.role,
   roleId: (a) => a.roleId?.toString() ?? null,
   isActive: (a) => a.isActive,
   mustChangePassword: (a) => Boolean(a.mustChangePassword),
   createdAt: (a) => a.createdAt,
}

/**
 * The signed-in admin, for login and /auth/me. `role` is the account kind;
 * `permissions` and `roleName` are resolved by the guard, never stored on the
 * user, so they are passed in rather than read off the document.
 */
export const presentAdminUser = (
   admin: IAdminUserDocument,
   access: { permissions: string[]; roleName: string }
) => ({
   ...present(admin, adminUserFields),
   permissions: access.permissions,
   roleName: access.roleName,
})

/** A row on the Users screen. */
const accessUserFields: FieldMap<IAdminUserDocument> = {
   ...adminUserFields,
   phone: (a) => a.phone ?? null,
   lastLoginAt: (a) => a.lastLoginAt ?? null,
}

export const presentAccessUser = (user: IAdminUserDocument, roleName: string) => ({
   ...present(user, accessUserFields),
   roleName,
})

const accessRoleFields: FieldMap<IAccessRoleDocument> = {
   id: (r) => r._id.toString(),
   name: (r) => r.name,
   description: (r) => r.description,
   permissions: (r) => [...r.permissions],
   createdAt: (r) => r.createdAt,
   updatedAt: (r) => r.updatedAt,
}

export const presentAccessRole = (role: IAccessRoleDocument, userCount: number) => ({
   ...present(role, accessRoleFields),
   userCount,
})

/** Security section device list (§14.1). */
const sessionFields: FieldMap<IAdminSession> = {
   id: (s) => s._id.toString(),
   deviceLabel: (s) => s.deviceLabel,
   ip: (s) => s.ip,
   createdAt: (s) => s.createdAt,
   lastSeenAt: (s) => s.lastSeenAt,
   revokedAt: (s) => s.revokedAt,
}

export const presentSessions = (sessions: IAdminSession[]) =>
   presentList(sessions, sessionFields)
