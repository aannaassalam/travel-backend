import { Request, Response } from 'express'
import { AUDIT_ACTIONS, PANEL_WORDS } from '../../constants/admin.constants'
import { presentAuditLogs } from '../../dto/admin/auditLog.dto'
import AuditLog from '../../model/auditLogModel'
import { byWords, paginate, sortBy } from '../../services/adminCrud.service'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/** Actions worth a second look: failed auth, sensitive reads, access changes. */
const RISKY_ACTIONS = [
   AUDIT_ACTIONS.LOGIN_FAILED,
   AUDIT_ACTIONS.STEP_UP_FAILED,
   AUDIT_ACTIONS.PASSPORT_UNMASKED,
   AUDIT_ACTIONS.CUSTOMER_EXPORTED,
   AUDIT_ACTIONS.FINANCIAL_EXPORTED,
   AUDIT_ACTIONS.BREAK_GLASS_ENABLED,
   AUDIT_ACTIONS.SESSIONS_REVOKED,
   AUDIT_ACTIONS.ADMIN_ACCESS_CHANGED,
   AUDIT_ACTIONS.PASSWORD_CHANGED,
   // Records removed for good.
   AUDIT_ACTIONS.PURGE,
]

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
/** Escaped, NUL-stripped, capped: user text never becomes a live regex. */
const rx = (value: string) =>
   new RegExp(
      value.replace(/\0/g, '').trim().slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i'
   )
/** A bare `to` date means "through the end of that day", not its first second. */
const endOfDay = (v: string) => {
   const d = new Date(v)
   if (/^\d{4}-\d{2}-\d{2}$/.test(v)) d.setUTCHours(23, 59, 59, 999)
   return d
}

/**
 * §14.6: searchable by entity, action, actor, date and IP. Read-only by
 * construction — there is deliberately no update or delete handler on this
 * router, and the model rejects those operations anyway.
 */
export const listAuditLogs = catchAsync(async (req: Request, res: Response) => {
   const { action, entityType, entityId, ip, from, to, actorEmail, q, risky } = req.query
   const filter: Record<string, any> = {}
   if (action) filter.action = action
   else if (risky === '1' || risky === 'true') filter.action = { $in: RISKY_ACTIONS }
   if (entityType) filter.entityType = entityType
   if (entityId) filter.entityId = entityId
   if (ip) filter.ip = ip
   if (str(actorEmail)) filter.actorEmail = new RegExp(`^${rx(str(actorEmail)!).source}$`, 'i')
   if (from || to) {
      filter.createdAt = {}
      if (from) filter.createdAt.$gte = new Date(String(from))
      if (to) filter.createdAt.$lte = endOfDay(String(to))
   }
   if (str(q)) {
      const term = rx(str(q)!)
      filter.$or = [{ actorEmail: term }, { entityId: term }, { reason: term }, { action: term }]
   }
   // Bounded and paged like every other list (§2.2), newest first.
   const { items, ...paging } = await paginate(
      AuditLog,
      filter,
      req,
      sortBy(req.query.sort, {
         when: 'createdAt',
         // By the words in the cell, not the codes under them.
         what: byWords('action', PANEL_WORDS.auditAction),
         who: 'actorEmail',
         on: ['entityType', 'entityId'],
         details: 'reason',
         ip: 'ip',
      })
   )
   return sendResponse(res, 200, 'OK', {
      items: presentAuditLogs(items as any),
      ...paging,
   })
})

/** Headline counts for the owner, plus the distinct values the filters offer. */
export const auditLogSummary = catchAsync(async (_req: Request, res: Response) => {
   const since = (ms: number) => ({ createdAt: { $gte: new Date(Date.now() - ms) } })
   const DAY = 24 * 60 * 60 * 1000
   const count = (action: string | string[], ms: number) =>
      AuditLog.countDocuments({
         action: Array.isArray(action) ? { $in: action } : action,
         ...since(ms),
      })

   const [
      failedLogins24h,
      stepUpFailed7d,
      exports30d,
      passportUnmasked30d,
      accessChanges30d,
      last,
      actions,
      entityTypes,
      actors,
   ] = await Promise.all([
      count(AUDIT_ACTIONS.LOGIN_FAILED, DAY),
      count(AUDIT_ACTIONS.STEP_UP_FAILED, 7 * DAY),
      count([AUDIT_ACTIONS.CUSTOMER_EXPORTED, AUDIT_ACTIONS.FINANCIAL_EXPORTED], 30 * DAY),
      count(AUDIT_ACTIONS.PASSPORT_UNMASKED, 30 * DAY),
      count(AUDIT_ACTIONS.ADMIN_ACCESS_CHANGED, 30 * DAY),
      AuditLog.findOne({ action: AUDIT_ACTIONS.LOGIN_FAILED })
         .sort({ _id: -1 })
         .select('actorEmail ip createdAt'),
      AuditLog.distinct('action'),
      AuditLog.distinct('entityType'),
      AuditLog.distinct('actorEmail'),
   ])

   return sendResponse(res, 200, 'OK', {
      failedLogins24h,
      stepUpFailed7d,
      exports30d,
      passportUnmasked30d,
      accessChanges30d,
      lastFailedLogin: last
         ? { actorEmail: last.actorEmail, ip: last.ip, createdAt: last.createdAt }
         : null,
      alertChannelConfigured: Boolean(process.env.ADMIN_ALERT_EMAIL),
      actions: actions.filter(Boolean).sort(),
      entityTypes: entityTypes.filter(Boolean).sort(),
      actors: actors.filter(Boolean).sort().slice(0, 100),
   })
})
