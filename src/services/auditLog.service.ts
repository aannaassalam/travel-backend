import { Request } from 'express'
import {
   AuditAction,
   OUT_OF_BAND_ALERTS,
} from '../constants/admin.constants'
import AuditLog from '../model/auditLogModel'

/**
 * §2.2: every mutation writes an audit entry, enforced at the service layer
 * rather than left to individual endpoints. Sensitive *reads* go through here
 * too (passport unmask, exports).
 */

/**
 * Never let these reach the audit log, whatever the diff says.
 *
 * `documentnumber` matters especially: it is encrypted at rest (§14.5) but
 * `toObject()` runs the decrypting getter, so a diff of an order would
 * otherwise write plaintext passport numbers into a log that is retained for
 * two years and can never be edited or deleted.
 */
const REDACTED_KEYS = [
   'password',
   'passwordconfirm',
   'totpsecret',
   'recoverycodes',
   'token',
   'secret',
   'apikey',
   'credentials',
   'documentnumber',
]

const redact = (value: any): any => {
   if (!value || typeof value !== 'object') return value
   if (Array.isArray(value)) return value.map(redact)
   return Object.entries(value).reduce<Record<string, any>>((acc, [k, v]) => {
      acc[k] = REDACTED_KEYS.includes(k.toLowerCase()) ? '[REDACTED]' : redact(v)
      return acc
   }, {})
}

/** Exposed for the leak tests — not part of the public surface. */
export const __testRedact = redact

/**
 * Key order is not a change. A document read back from Mongoose can list the
 * keys of a nested object in a different order from the one just saved, and
 * a plain JSON comparison then reports every settings save as having changed
 * the whole offices list.
 */
const stable = (value: any): any => {
   if (Array.isArray(value)) return value.map(stable)
   if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.keys(value)
         .sort()
         .reduce<Record<string, any>>((acc, k) => {
            acc[k] = stable(value[k])
            return acc
         }, {})
   }
   return value
}

/** Only the fields that actually changed — a full-document diff is unreadable. */
const diff = (before: any, after: any) => {
   if (!before || !after) {
      return { before: redact(before), after: redact(after) }
   }
   const keys = new Set([...Object.keys(before), ...Object.keys(after)])
   const b: Record<string, any> = {}
   const a: Record<string, any> = {}
   keys.forEach((k) => {
      if (JSON.stringify(stable(before[k])) !== JSON.stringify(stable(after[k]))) {
         b[k] = before[k]
         a[k] = after[k]
      }
   })
   return { before: redact(b), after: redact(a) }
}

export interface AuditInput {
   action: AuditAction | string
   entityType?: string
   entityId?: string
   before?: any
   after?: any
   reason?: string
   /** Overrides the actor taken from req.admin — used for failed logins. */
   actorEmail?: string
}

export const recordAudit = async (req: Request, input: AuditInput) => {
   const admin = (req as any).admin
   const { before, after } = diff(input.before, input.after)

   const entry = await AuditLog.create({
      actorId: admin?._id,
      actorEmail: input.actorEmail || admin?.email || 'anonymous',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before,
      after,
      reason: input.reason,
      ip: req.ip || '',
      userAgent: req.get('user-agent') || '',
      sessionId: (req as any).adminSessionId,
   })

   if (OUT_OF_BAND_ALERTS.includes(input.action as AuditAction)) {
      await sendOutOfBandAlert(entry.action, entry.actorEmail, entry.ip)
   }

   return entry
}

/**
 * §14.2: alerts must go to a channel not reachable from the admin panel, so an
 * attacker inside the panel cannot suppress them.
 *
 * ponytail: logs to stderr until ALERT_EMAIL / ALERT_PHONE are configured —
 * swap in the existing azureEmailService + msg91 sender once §18 Q2 is answered
 * (which addresses these alerts should go to).
 */
export const sendOutOfBandAlert = async (
   action: string,
   actor: string,
   ip: string
) => {
   const destination = process.env.ADMIN_ALERT_EMAIL
   const line = `[SECURITY ALERT] ${action} by ${actor} from ${ip} at ${new Date().toISOString()}`
   if (!destination) {
      console.error(`${line} — ADMIN_ALERT_EMAIL unset, alert not delivered`)
      return
   }
   console.error(`${line} → ${destination}`)
}
