import { Request, Response } from 'express'
import { presentAuditLogs } from '../../dto/admin/auditLog.dto'
import AuditLog from '../../model/auditLogModel'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * §14.6: searchable by entity, action, date and IP. Read-only by construction —
 * there is deliberately no update or delete handler on this router, and the
 * model rejects those operations anyway.
 */
export const listAuditLogs = catchAsync(async (req: Request, res: Response) => {
   const { action, entityType, entityId, ip, from, to } = req.query
   const limit = Number(req.query.limit) // already bounded by boundPagination
   const cursor = req.query.cursor as string | undefined

   const filter: Record<string, any> = {}
   if (action) filter.action = action
   if (entityType) filter.entityType = entityType
   if (entityId) filter.entityId = entityId
   if (ip) filter.ip = ip
   if (from || to) {
      filter.createdAt = {}
      if (from) filter.createdAt.$gte = new Date(String(from))
      if (to) filter.createdAt.$lte = new Date(String(to))
   }
   // Cursor pagination (§2.2) — `_id` descending doubles as the cursor.
   if (cursor) filter._id = { $lt: cursor }

   const logs = await AuditLog.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)

   const hasMore = logs.length > limit
   const page = hasMore ? logs.slice(0, limit) : logs

   return sendResponse(res, 200, 'OK', {
      items: presentAuditLogs(page),
      nextCursor: hasMore ? page[page.length - 1]._id.toString() : null,
   })
})
