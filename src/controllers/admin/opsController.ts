import { NextFunction, Request, Response } from 'express'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { PAYMENT_STATUS } from '../../constants/domain.constants'
import { presentSessions } from '../../dto/admin/adminUser.dto'
import AuditLog from '../../model/auditLogModel'
import {
   Enquiry,
   NOTIFICATION_EVENTS,
   NotificationLog,
   NotificationTemplate,
   NOTIFICATION_CHANNELS,
   TEMPLATE_VARIABLES,
} from '../../model/enquiryModel'
import { Order } from '../../model/orderModel'
import SettingsModel, { getSettings, PolicyVersion } from '../../model/settingsModel'
import { paginate } from '../../services/adminCrud.service'
import { recordAudit } from '../../services/auditLog.service'
import { money, notify, pushBody, render } from '../../services/notifications/notify.service'
import { sendSms, smsConfigured } from '../../services/notifications/sms.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { FieldMap, maskPhone, present, presentList } from '../../utils/present'
import { sendResponse } from '../../utils/response'
import { forReader } from '../../middleware/adminAuth'

// ===========================================================================
// Enquiries (§7)
// ===========================================================================

const enquiryFields: FieldMap<any> = {
   id: (e) => e._id.toString(),
   reference: (e) => e.reference,
   kind: (e) => e.kind,
   stage: (e) => e.stage,
   vertical: (e) => e.vertical,
   customerName: (e) => e.customerName,
   phone: (e) => e.phone,
   email: (e) => e.email,
   message: (e) => e.message,
   listingLabel: (e) => e.listingLabel,
   source: (e) => e.source,
   firstContactAt: (e) => e.firstContactAt,
   lossReason: (e) => e.lossReason,
   quotedAmount: (e) => e.quotedAmount,
   contactLog: (e) =>
      e.contactLog?.map((c: any) => ({
         at: c.at,
         kind: c.kind,
         detail: c.detail,
         actorEmail: c.actorEmail,
      })),
   createdAt: (e) => e.createdAt,
}

export const listEnquiries = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, any> = {}
   if (req.query.stage) filter.stage = req.query.stage
   if (req.query.kind) filter.kind = req.query.kind

   const { items, nextCursor } = await paginate(Enquiry, filter, req)
   const settings = await getSettings()

   /**
    * §7: SLA timer on each enquiry, visible and colour-coded, escalating when
    * breached. §15 lists "no SLA or escalation on enquiries — leads simply go
    * cold" as a thing to avoid, so the breach is computed server-side rather
    * than left to each client to work out.
    */
   const slaMs = settings.enquirySlaHours * 3600 * 1000
   const withSla = (items as any[]).map((e) => {
      const dto = present(e, enquiryFields) as any
      const deadline = new Date(e.createdAt.getTime() + slaMs)
      dto.slaDeadline = deadline
      dto.slaBreached = !e.firstContactAt && Date.now() > deadline.getTime()
      dto.hoursWaiting = e.firstContactAt
         ? null
         : Math.round((Date.now() - e.createdAt.getTime()) / 3600000)
      return dto
   })

   return sendResponse(res, 200, 'OK', {
      items: withSla,
      nextCursor,
      slaHours: settings.enquirySlaHours,
   })
})

export const updateEnquiryStage = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { stage, lossReason, detail } = req.body
      const enquiry = await Enquiry.findById(req.params.id)
      if (!enquiry) return next(new AppError('Enquiry not found', 404))

      if (stage === 'LOST' && !lossReason) {
         // §7: LOST always carries a reason, or the pipeline teaches nothing.
         return next(new AppError('A loss reason is required', 400))
      }

      const before = enquiry.toObject()
      enquiry.stage = stage
      if (lossReason) enquiry.lossReason = lossReason
      // Moving off NEW is the first contact — stops the SLA clock.
      if (stage !== 'NEW' && !enquiry.firstContactAt) {
         enquiry.firstContactAt = new Date()
      }
      enquiry.contactLog.push({
         at: new Date(),
         kind: 'NOTE',
         detail: detail || `Stage → ${stage}`,
         actorEmail: (req as any).admin?.email,
      })
      await enquiry.save()

      // A quote the customer is never told about is not a quote.
      if (stage === 'QUOTED') {
         void notify({
            event: NOTIFICATION_EVENTS.QUOTE_SENT,
            recipient: enquiry.phone,
            vars: {
               customer_name: enquiry.customerName,
               order_ref: enquiry.reference,
               listing_title: enquiry.listingLabel ?? '',
               amount: enquiry.quotedAmount ? money(enquiry.quotedAmount) : '',
               currency: 'USD',
            },
         })
      }

      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'Enquiry',
         entityId: enquiry._id.toString(),
         before,
         after: enquiry.toObject(),
         reason: detail,
      })
      return sendResponse(res, 200, `Moved to ${stage}`, {
         // The full enquiry only for someone who may read enquiries.
         enquiry: forReader(req, 'enquiries:read', () => present(enquiry, enquiryFields), {
            id: enquiry._id.toString(),
            stage: enquiry.stage,
         }),
      })
   }
)

// ===========================================================================
// Payments (§9.1)
// ===========================================================================

/** Payments ledger, derived from orders until a gateway is wired. */
export const listPayments = catchAsync(async (req: Request, res: Response) => {
   const filter: Record<string, any> = {
      paymentStatus: { $ne: PAYMENT_STATUS.UNPAID },
   }
   const { items, nextCursor } = await paginate(Order, filter, req, {
      populate: 'customer',
   })

   return sendResponse(res, 200, 'OK', {
      items: (items as any[]).map((o) => ({
         id: o._id.toString(),
         reference: o.reference,
         customerName: o.customer?.firstName
            ? `${o.customer.firstName} ${o.customer.lastName ?? ''}`.trim()
            : '—',
         method: o.paymentMethod,
         status: o.paymentStatus,
         amount: o.total,
         currency: o.currency,
         chargedTotal: o.chargedTotal,
         chargedCurrency: o.chargedCurrency,
         fxRate: o.fxRate,
         paidAt: o.paidAt,
         createdAt: o.createdAt,
      })),
      nextCursor,
   })
})

// ===========================================================================
// Content — versioned policies (§10)
// ===========================================================================

const policyFields: FieldMap<any> = {
   id: (p) => p._id.toString(),
   kind: (p) => p.kind,
   locale: (p) => p.locale,
   label: (p) => p.label,
   body: (p) => p.body,
   isLive: (p) => p.isLive,
   createdAt: (p) => p.createdAt,
}

export const listPolicies = catchAsync(async (_req: Request, res: Response) => {
   const policies = await PolicyVersion.find().sort({ _id: -1 })
   return sendResponse(res, 200, 'OK', {
      items: presentList(policies, policyFields),
   })
})

/**
 * §10: editing creates a NEW version; the old one is retained forever because
 * historical orders reference it. §15 calls editing published policy text in
 * place a hard constraint violation — it destroys the evidence behind every
 * historical order, which is what §9.3's chargeback defence rests on.
 */
export const createPolicyVersion = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { kind, locale, label, body } = req.body
      if (!kind || !locale || !label || !body) {
         return next(new AppError('kind, locale, label and body are required', 400))
      }
      const version = await PolicyVersion.create({
         kind,
         locale,
         label,
         body,
         isLive: false,
         createdBy: (req as any).admin._id,
      })
      await recordAudit(req, {
         action: AUDIT_ACTIONS.CREATE,
         entityType: 'PolicyVersion',
         entityId: version._id.toString(),
         after: version.toObject(),
      })
      return sendResponse(res, 201, 'New policy version created', {
         policy: present(version, policyFields),
      })
   }
)

export const setPolicyLive = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const version = await PolicyVersion.findById(req.params.id)
      if (!version) return next(new AppError('Policy version not found', 404))

      // Exactly one live version per kind+locale.
      const siblings = await PolicyVersion.find({
         kind: version.kind,
         locale: version.locale,
         isLive: true,
      })
      for (const s of siblings) {
         s.isLive = false
         await s.save()
      }
      version.isLive = true
      await version.save()

      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'PolicyVersion',
         entityId: version._id.toString(),
         after: { isLive: true, label: version.label },
         reason: req.body.reason,
      })
      return sendResponse(res, 200, `${version.label} is now live`, {
         policy: present(version, policyFields),
      })
   }
)

// ===========================================================================
// Settings (§12)
// ===========================================================================

const settingsFields: FieldMap<any> = {
   companyName: (s) => s.companyName,
   supportEmail: (s) => s.supportEmail,
   supportPhone: (s) => s.supportPhone,
   // Public contact block. `updateSettings` writes whatever this map names, so
   // listing them here is what makes them editable as well as readable.
   whatsappNumber: (s) => s.whatsappNumber,
   streetAddress: (s) => s.streetAddress,
   city: (s) => s.city,
   country: (s) => s.country,
   officeHours: (s) => s.officeHours,
   enabledLocales: (s) => s.enabledLocales,
   defaultLocale: (s) => s.defaultLocale,
   enabledCurrencies: (s) => s.enabledCurrencies,
   baseCurrency: (s) => s.baseCurrency,
   priceChangeGuardPercent: (s) => s.priceChangeGuardPercent,
   holdTtlOnlineMinutes: (s) => s.holdTtlOnlineMinutes,
   holdTtlCashHours: (s) => s.holdTtlCashHours,
   maxConcurrentCashHolds: (s) => s.maxConcurrentCashHolds,
   customerExportRowCap: (s) => s.customerExportRowCap,
   atRiskWindowDays: (s) => s.atRiskWindowDays,
   enquirySlaHours: (s) => s.enquirySlaHours,
   passportRetentionDays: (s) => s.passportRetentionDays,
   maintenanceMode: (s) => s.maintenanceMode,
   updatedAt: (s) => s.updatedAt,
   // Payment provider credentials are WRITE-ONLY (§12, §14.5) — enterable,
   // never displayed after saving. Only whether one is set is exposed.
}

export const getSettingsHandler = catchAsync(
   async (_req: Request, res: Response) => {
      const settings = await getSettings()
      return sendResponse(res, 200, 'OK', {
         settings: present(settings, settingsFields),
      })
   }
)

/** §1.3: settings changes require step-up re-auth (enforced at the route). */
export const updateSettings = catchAsync(async (req: Request, res: Response) => {
   const settings = await getSettings()
   const before = settings.toObject()

   Object.keys(settingsFields).forEach((key) => {
      if (key === 'updatedAt') return
      if (req.body[key] !== undefined) (settings as any)[key] = req.body[key]
   })
   await settings.save()

   await recordAudit(req, {
      action: AUDIT_ACTIONS.UPDATE,
      entityType: 'Settings',
      entityId: (settings as any)._id.toString(),
      before,
      after: settings.toObject(),
      reason: req.body.reason,
   })
   return sendResponse(res, 200, 'Settings saved', {
      settings: present(settings, settingsFields),
   })
})

// ===========================================================================
// Security (§14.1, §14.4)
// ===========================================================================

export const getSecurityOverview = catchAsync(
   async (req: Request, res: Response) => {
      const admin = (req as any).admin
      const active = admin.sessions.filter((s: any) => !s.revokedAt)

      // §14.4: a dedicated export log visible in the Security section.
      const exports = await AuditLog.find({
         action: { $in: [AUDIT_ACTIONS.CUSTOMER_EXPORTED, AUDIT_ACTIONS.FINANCIAL_EXPORTED] },
      })
         .sort({ _id: -1 })
         .limit(25)

      const recentFailures = await AuditLog.find({
         action: AUDIT_ACTIONS.LOGIN_FAILED,
      })
         .sort({ _id: -1 })
         .limit(10)

      return sendResponse(res, 200, 'OK', {
         currentSessionId: (req as any).adminSessionId,
         sessions: presentSessions(active),
         exportLog: exports.map((e) => ({
            id: e._id.toString(),
            action: e.action,
            actorEmail: e.actorEmail,
            ip: e.ip,
            rows: (e.after as any)?.rows,
            createdAt: e.createdAt,
         })),
         recentFailedLogins: recentFailures.map((e) => ({
            id: e._id.toString(),
            actorEmail: e.actorEmail,
            ip: e.ip,
            reason: e.reason,
            createdAt: e.createdAt,
         })),
         // §14.2: surfaced so an unconfigured alert channel is visible, not silent.
         alertChannelConfigured: Boolean(process.env.ADMIN_ALERT_EMAIL),
      })
   }
)

// ===========================================================================
// Notifications (§11)
// ===========================================================================

const templateFields: FieldMap<any> = {
   id: (t) => t._id.toString(),
   event: (t) => t.event,

   channel: (t) => t.channel,
   subject: (t) => t.subject,
   body: (t) => t.body,
   isActive: (t) => t.isActive,
   updatedAt: (t) => t.updatedAt,
}

export const listTemplates = catchAsync(async (req: Request, res: Response) => {
   /**
    * notifications:read is for whoever maintains the wording. The delivery log
    * carries customers' numbers and messages with order links in them, which is
    * order data: the number is masked for everyone here, and the text is shown
    * only to someone who may read orders anyway.
    */
   const mayReadOrders = ((req as any).adminAccess?.permissions ?? []).includes('orders:read')
   const [templates, logs] = await Promise.all([
      NotificationTemplate.find().sort({ event: 1, channel: 1 }),
      NotificationLog.find().sort({ _id: -1 }).limit(25),
   ])
   return sendResponse(res, 200, 'OK', {
      items: presentList(templates, templateFields),
      variables: TEMPLATE_VARIABLES,
      events: Object.values(NOTIFICATION_EVENTS),
      channels: NOTIFICATION_CHANNELS,
      deliveryLog: logs.map((l) => ({
         id: l._id.toString(),
         event: l.event,
         channel: l.channel,
         recipient: maskPhone(l.recipient),
         status: l.status,
         body: mayReadOrders ? l.body : undefined,
         // A provider's failure text can quote the number it was sending to.
         providerMessage: l.providerMessage?.replace(/\+?\d{9,15}/g, (m) => maskPhone(m) ?? ''),
         createdAt: l.createdAt,
      })),
      smsCostMinor: logs
         .filter((l) => l.channel === 'SMS')
         .reduce((s, l) => s + (l.costMinor || 0), 0),
   })
})

/**
 * §11: unknown placeholders block saving, and sensitive data is refused
 * outright — SMS is unencrypted in transit and persists on handsets forever.
 */
const SENSITIVE_PLACEHOLDERS = [
   'passport',
   'document_number',
   'card',
   'cvv',
   'password',
   'document_link',
]

export const upsertTemplate = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { event, channel, subject, body, isActive } = req.body
      if (!event || !channel || !body) {
         return next(new AppError('event, channel and body are required', 400))
      }
      /**
       * Checked here, explicitly.
       *
       * The schema enum does not cover this: `channel` is part of the upsert
       * FILTER, and mongoose only validates fields it is setting — so
       * `runValidators` happily wrote an EMAIL template that the model claims
       * cannot exist and that nothing in the system would ever deliver.
       */
      if (!NOTIFICATION_CHANNELS.includes(channel)) {
         return next(
            new AppError(
               `channel must be one of: ${NOTIFICATION_CHANNELS.join(', ')}`,
               400,
               'UNKNOWN_CHANNEL'
            )
         )
      }
      if (!Object.values(NOTIFICATION_EVENTS).includes(event)) {
         return next(new AppError('Unknown event', 400, 'UNKNOWN_EVENT'))
      }

      const used = [...String(body).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map(
         (m) => m[1]
      )
      const unknown = used.filter(
         (v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v)
      )
      if (unknown.length) {
         return next(
            new AppError(
               `Unknown variable(s): ${unknown.join(', ')}. Allowed: ${TEMPLATE_VARIABLES.join(', ')}`,
               400
            )
         )
      }
      const sensitive = SENSITIVE_PLACEHOLDERS.filter((s) =>
         `${subject ?? ''} ${body}`.toLowerCase().includes(s)
      )
      if (sensitive.length) {
         return next(
            new AppError(
               `Notification content must not carry sensitive data (found: ${sensitive.join(', ')}). SMS is unencrypted in transit and persists on handsets.`,
               400
            )
         )
      }

      const before = await NotificationTemplate.findOne({ event, channel })
      const template = await NotificationTemplate.findOneAndUpdate(
         { event, channel },
         { subject, body, isActive: isActive ?? true },
         { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
      )

      await recordAudit(req, {
         action: before ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE,
         entityType: 'NotificationTemplate',
         entityId: template!._id.toString(),
         before: before?.toObject(),
         after: template!.toObject(),
      })
      return sendResponse(res, 200, 'Template saved', {
         template: present(template, templateFields),
      })
   }
)

/** §11: send-test-to-me before saving. A broken template reaches every customer. */
/**
 * "Send test to me" — a real send to the admin's own number.
 *
 * It used to render a preview and write a log line saying it had been sent,
 * which is the one thing a test button must never do: it certified a channel
 * that had never carried a message. Now it either delivers or reports why not.
 */
export const sendTestNotification = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { event, channel, body } = req.body
      const admin = (req as any).admin
      const to = String(req.body.to || admin.phone || '').trim()

      const vars = {
         customer_name: admin.name || 'Test',
         order_ref: 'FA-TEST0-00000',
         amount: '100.00',
         currency: 'USD',
         departure_date: new Date().toISOString().slice(0, 10),
         listing_title: 'Test listing',
         deadline: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      }
      const rendered = render(String(body || ''), vars)

      if (channel === 'PUSH') {
         // A push goes to a customer's app install, and an administrator has
         // none — so this can only ever be a preview. Nothing is logged: a
         // delivery-log row for a message that could not be sent is noise.
         return sendResponse(
            res,
            200,
            'Preview only: a push goes to the customer app and cannot be test-sent from here',
            { preview: pushBody(String(body || ''), vars), delivered: false }
         )
      }

      if (!to) {
         return next(
            new AppError('Add a phone number to your admin profile, or pass one as "to"', 400)
         )
      }
      if (!smsConfigured()) {
         await NotificationLog.create({
            event: event || 'TEST',
            channel: 'SMS',
            recipient: to,
            status: 'FAILED',
            providerMessage: 'SMS provider is not configured',
         })
         return next(new AppError('SMS provider is not configured', 503))
      }

      try {
         const result = await sendSms(to, rendered)
         await NotificationLog.create({
            event: event || 'TEST',
            channel: 'SMS',
            recipient: to,
            status: 'SENT',
            providerMessage: `${result.sid} (${result.status})`,
            costMinor: result.costMinor,
         })
         return sendResponse(res, 200, `Sent to ${to}`, { preview: rendered, delivered: true })
      } catch (err) {
         await NotificationLog.create({
            event: event || 'TEST',
            channel: 'SMS',
            recipient: to,
            status: 'FAILED',
            providerMessage: (err as Error).message.slice(0, 300),
         })
         return next(new AppError((err as Error).message, 502))
      }
   }
)
