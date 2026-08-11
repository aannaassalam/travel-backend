import { IAuditLogDocument } from '../../model/auditLogModel'
import { FieldMap, presentList } from '../../utils/present'

const auditLogFields: FieldMap<IAuditLogDocument> = {
   id: (l) => l._id.toString(),
   actorEmail: (l) => l.actorEmail,
   action: (l) => l.action,
   entityType: (l) => l.entityType,
   entityId: (l) => l.entityId,
   before: (l) => l.before,
   after: (l) => l.after,
   reason: (l) => l.reason,
   ip: (l) => l.ip,
   userAgent: (l) => l.userAgent,
   createdAt: (l) => l.createdAt,
}

export const presentAuditLogs = (logs: IAuditLogDocument[]) =>
   presentList(logs, auditLogFields)
