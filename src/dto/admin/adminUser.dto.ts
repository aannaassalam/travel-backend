import { IAdminUserDocument } from '../../constants/interfaces/IAdminUser'
import { IAdminSession } from '../../constants/interfaces/IAdminUser'
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
   isActive: (a) => a.isActive,
   createdAt: (a) => a.createdAt,
}

export const presentAdminUser = (admin: IAdminUserDocument) =>
   present(admin, adminUserFields)

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
