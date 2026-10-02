import mongoose, { Document, Schema, Types } from 'mongoose'
import { AuditAction } from '../constants/admin.constants'

export interface IAuditLogDocument extends Document {
   actorId?: Types.ObjectId
   actorEmail: string
   action: AuditAction | string
   entityType?: string
   entityId?: string
   /** Only changed fields, sensitive values already redacted by the service. */
   before?: Record<string, any>
   after?: Record<string, any>
   reason?: string
   ip: string
   userAgent: string
   sessionId?: string
   createdAt: Date
}

const auditLogSchema = new Schema<IAuditLogDocument>(
   {
      actorId: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
      actorEmail: { type: String, default: 'anonymous', index: true },
      action: { type: String, required: true, index: true },
      entityType: { type: String, index: true },
      entityId: { type: String, index: true },
      before: Schema.Types.Mixed,
      after: Schema.Types.Mixed,
      reason: String,
      ip: { type: String, default: '' },
      userAgent: { type: String, default: '' },
      sessionId: String,
      createdAt: { type: Date, default: Date.now, index: true },
   },
   { versionKey: false }
)

/**
 * §14.6: append-only, and not editable or deletable from the UI under any
 * circumstance — including by the super administrator. An audit log the
 * administrator can edit is not an audit log; with a single account it is the
 * only thing that can distinguish the owner from an attacker using his session.
 *
 * Enforced at the model so no future controller can bypass it by accident.
 */
const BLOCKED = [
   'updateOne',
   'updateMany',
   'findOneAndUpdate',
   'findOneAndReplace',
   'replaceOne',
   'deleteOne',
   'deleteMany',
   'findOneAndDelete',
] as const

BLOCKED.forEach((op) => {
   auditLogSchema.pre(op as any, function (next: (err?: Error) => void) {
      next(new Error(`Audit log is append-only: ${op} is not permitted`))
   })
})

auditLogSchema.pre('save', function (next) {
   if (!this.isNew) return next(new Error('Audit log entries are immutable'))
   next()
})

// ponytail: application-level immutability only. For tamper-evidence against a
// database compromise, ship these to append-only external storage (§14.6).

const AuditLog = mongoose.model<IAuditLogDocument>('AuditLog', auditLogSchema)

export default AuditLog
