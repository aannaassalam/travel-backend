import { NextFunction, Request, Response } from 'express'
import { isValidObjectId } from 'mongoose'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { PAYMENT_STATUS } from '../../constants/domain.constants'
import {
   Enquiry,
   ENQUIRY_STAGES,
   LOSS_REASONS,
   NOTIFICATION_EVENTS,
   NotificationLog,
   NotificationTemplate,
   NOTIFICATION_CHANNELS,
   TEMPLATE_VARIABLES,
} from '../../model/enquiryModel'
import { Order } from '../../model/orderModel'
import SettingsModel, { getSettings, PolicyVersion } from '../../model/settingsModel'
import { geoPoint, parseGeo } from '../../model/shared.schema'
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
   listingId: (e) => e.listingId?.toString(),
   listingLabel: (e) => e.listingLabel,
   source: (e) => e.source,
   firstContactAt: (e) => e.firstContactAt,
   lossReason: (e) => e.lossReason,
   quotedAmount: (e) => e.quotedAmount,
   quoteExpiresAt: (e) => e.quoteExpiresAt,
   contactLog: (e) =>
      e.contactLog
         // The public create endpoint parks its idempotency key here; it is
         // plumbing, not a note anyone wrote.
         ?.filter((c: any) => !String(c.detail ?? '').startsWith('idem:'))
         .map((c: any) => ({
            at: c.at,
            kind: c.kind,
            detail: c.detail,
            actorEmail: c.actorEmail,
         })),
   createdAt: (e) => e.createdAt,
}

const STAGES = Object.values(ENQUIRY_STAGES) as string[]
const REASONS = Object.values(LOSS_REASONS) as string[]
const MAX_DETAIL = 1000

/** Escaped, NUL-free, capped — a pasted paragraph never becomes a regex. */
const rx = (value: string) =>
   new RegExp(
      value.replace(/\0/g, '').trim().slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i'
   )

const detailText = (value: unknown) => {
   if (value === undefined || value === null || value === '') return undefined
   if (typeof value !== 'string') throw new AppError('detail must be text', 400)
   const text = value.trim()
   if (text.length > MAX_DETAIL) {
      throw new AppError(`detail is limited to ${MAX_DETAIL} characters`, 400)
   }
   return text || undefined
}

/**
 * §7: SLA timer on each enquiry, visible and colour-coded, escalating when
 * breached. §15 lists "no SLA or escalation on enquiries — leads simply go
 * cold" as a thing to avoid, so the breach is computed server-side rather
 * than left to each client to work out.
 */
const withSla = (e: any, slaHours: number) => {
   const dto = present(e, enquiryFields) as any
   const deadline = new Date(e.createdAt.getTime() + slaHours * 3600 * 1000)
   dto.slaDeadline = deadline
   dto.slaBreached = !e.firstContactAt && Date.now() > deadline.getTime()
   dto.hoursWaiting = e.firstContactAt
      ? null
      : Math.round((Date.now() - e.createdAt.getTime()) / 3600000)
   return dto
}

/** Not yet contacted and older than the SLA window. */
const overdueFilter = (slaHours: number) => ({
   firstContactAt: { $exists: false },
   createdAt: { $lt: new Date(Date.now() - slaHours * 3600 * 1000) },
})

export const listEnquiries = catchAsync(async (req: Request, res: Response) => {
   const settings = await getSettings()
   const filter: Record<string, any> = {}
   if (req.query.stage) filter.stage = req.query.stage
   if (req.query.kind) filter.kind = req.query.kind
   if (req.query.overdue === '1') Object.assign(filter, overdueFilter(settings.enquirySlaHours))

   const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
   if (q) {
      const term = rx(q)
      const or: Record<string, any>[] = [
         { reference: term },
         { customerName: term },
         { phone: term },
         { email: term },
      ]
      // "081 234 56 78" typed the local way: numbers are stored as +243…
      const digits = q.replace(/[\s.\-()]/g, '')
      if (/^0\d{5,}$/.test(digits)) or.push({ phone: rx(`+243${digits.slice(1)}`) })
      filter.$or = or
   }

   const { items, nextCursor } = await paginate(Enquiry, filter, req)
   return sendResponse(res, 200, 'OK', {
      items: (items as any[]).map((e) => withSla(e, settings.enquirySlaHours)),
      nextCursor,
      slaHours: settings.enquirySlaHours,
   })
})

export const enquirySummary = catchAsync(async (_req: Request, res: Response) => {
   const settings = await getSettings()
   const since = new Date(Date.now() - 30 * 86400000)
   const [stages, overdue, won] = await Promise.all([
      Enquiry.aggregate([{ $group: { _id: '$stage', n: { $sum: 1 } } }]),
      Enquiry.countDocuments(overdueFilter(settings.enquirySlaHours)),
      Enquiry.aggregate([
         { $match: { stage: ENQUIRY_STAGES.WON, updatedAt: { $gte: since } } },
         { $group: { _id: null, count: { $sum: 1 }, value: { $sum: { $ifNull: ['$quotedAmount', 0] } } } },
      ]),
   ])
   const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]))
   stages.forEach((s: any) => (byStage[s._id] = s.n))
   return sendResponse(res, 200, 'OK', {
      byStage,
      overdue,
      slaHours: settings.enquirySlaHours,
      wonLast30d: { count: won[0]?.count ?? 0, value: won[0]?.value ?? 0 },
   })
})

/**
 * The one place a stage changes: first-contact clock, log line, quote SMS.
 * `detail` null skips the log line, for a caller that writes its own.
 */
const applyStage = (enquiry: any, stage: string, detail: string | null | undefined, req: Request) => {
   enquiry.stage = stage
   // Moving off NEW is the first contact — stops the SLA clock.
   if (stage !== ENQUIRY_STAGES.NEW && !enquiry.firstContactAt) {
      enquiry.firstContactAt = new Date()
   }
   if (detail !== null) {
      enquiry.contactLog.push({
         at: new Date(),
         kind: 'NOTE',
         detail: detail || `Stage → ${stage}`,
         actorEmail: (req as any).admin?.email,
      })
   }
   // A quote the customer is never told about is not a quote.
   if (stage === ENQUIRY_STAGES.QUOTED) {
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
}

/** Save, audit and answer with the enquiry — shared tail of every write. */
const finishEnquiryWrite = async (
   req: Request,
   res: Response,
   enquiry: any,
   before: any,
   message: string,
   reason?: string
) => {
   await enquiry.save()
   await recordAudit(req, {
      action: AUDIT_ACTIONS.UPDATE,
      entityType: 'Enquiry',
      entityId: enquiry._id.toString(),
      before,
      after: enquiry.toObject(),
      reason,
   })
   const settings = await getSettings()
   return sendResponse(res, 200, message, {
      // The full enquiry only for someone who may read enquiries.
      enquiry: forReader(req, 'enquiries:read', () => withSla(enquiry, settings.enquirySlaHours), {
         id: enquiry._id.toString(),
         stage: enquiry.stage,
      }),
   })
}

export const updateEnquiryStage = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { stage, lossReason } = req.body
      if (!STAGES.includes(stage)) {
         return next(new AppError(`stage must be one of: ${STAGES.join(', ')}`, 400))
      }
      if (lossReason !== undefined && !REASONS.includes(lossReason)) {
         return next(new AppError(`lossReason must be one of: ${REASONS.join(', ')}`, 400))
      }
      if (stage === ENQUIRY_STAGES.LOST && !lossReason) {
         // §7: LOST always carries a reason, or the pipeline teaches nothing.
         return next(new AppError('A loss reason is required', 400))
      }
      const detail = detailText(req.body.detail)
      const enquiry = await Enquiry.findById(req.params.id)
      if (!enquiry) return next(new AppError('Enquiry not found', 404))

      const before = enquiry.toObject()
      if (lossReason) enquiry.lossReason = lossReason
      applyStage(enquiry, stage, detail, req)
      return finishEnquiryWrite(req, res, enquiry, before, `Moved to ${stage}`, detail)
   }
)

/** A call, a note or a viewing. Contact made on a NEW lead stops the SLA clock. */
export const addEnquiryNote = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { kind } = req.body
      if (!['CALL', 'NOTE', 'VIEWING'].includes(kind)) {
         return next(new AppError('kind must be CALL, NOTE or VIEWING', 400))
      }
      const detail = detailText(req.body.detail)
      if (!detail) return next(new AppError('detail is required', 400))
      const enquiry = await Enquiry.findById(req.params.id)
      if (!enquiry) return next(new AppError('Enquiry not found', 404))

      const before = enquiry.toObject()
      const contacted = kind !== 'NOTE' && !enquiry.firstContactAt
      if (contacted && enquiry.stage === ENQUIRY_STAGES.NEW) {
         // The call entry below is the record; no second "Stage →" line.
         applyStage(enquiry, ENQUIRY_STAGES.CONTACTED, null, req)
      } else if (contacted) {
         enquiry.firstContactAt = new Date()
      }
      enquiry.contactLog.push({
         at: new Date(),
         kind,
         detail,
         actorEmail: (req as any).admin?.email,
      })
      return finishEnquiryWrite(req, res, enquiry, before, 'Logged')
   }
)

/** Sets the amount, then moves to QUOTED — so the quote SMS carries a figure. */
export const quoteEnquiry = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { amount, expiresAt } = req.body
      if (!Number.isInteger(amount) || amount <= 0) {
         return next(new AppError('amount must be a whole number of cents above zero', 400))
      }
      let expiry: Date | undefined
      if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
         expiry = new Date(expiresAt)
         if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
            return next(new AppError('expiresAt must be a date in the future', 400))
         }
      }
      const detail = detailText(req.body.detail)
      const enquiry = await Enquiry.findById(req.params.id)
      if (!enquiry) return next(new AppError('Enquiry not found', 404))

      const before = enquiry.toObject()
      enquiry.quotedAmount = amount
      enquiry.quoteExpiresAt = expiry
      const line = `Quoted USD ${(amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
      enquiry.contactLog.push({
         at: new Date(),
         kind: 'QUOTE',
         detail: detail ? `${line} — ${detail}` : line,
         actorEmail: (req as any).admin?.email,
      })
      applyStage(enquiry, ENQUIRY_STAGES.QUOTED, null, req)
      return finishEnquiryWrite(req, res, enquiry, before, 'Quote sent', detail)
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
   // listing it here is what makes it editable as well as readable.
   offices: (s) =>
      (s.offices ?? []).map((o: any) => ({
         id: o._id.toString(),
         name: o.name,
         city: o.city,
         streetAddress: o.streetAddress,
         phone: o.phone,
         whatsapp: o.whatsapp,
         email: o.email,
         hours: o.hours,
         geo: geoPoint(o.geo),
         isPrimary: o.isPrimary,
      })),
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

const MAX_OFFICES = 20

/** A free-text office field: trimmed, capped, blank allowed. */
const officeText = (value: unknown, label: string, max: number) => {
   if (value === undefined || value === null) return ''
   if (typeof value !== 'string') throw new AppError(`${label} must be text`, 400)
   const text = value.trim()
   if (text.length > max) throw new AppError(`${label} is limited to ${max} characters`, 400)
   return text
}

/**
 * The office list from the form, as a full replacement. Exactly one office is
 * primary — the first one marked, or the first one listed — because the public
 * API fills the legacy single-office fields from it and cannot pick between two.
 */
/**
 * A number the footer can turn into a tel: and a wa.me link: digits with an
 * optional leading +, 8 to 15 of them. Spaces, dots and dashes are allowed
 * for reading and stripped. "081 000 00 00" written the local way is refused
 * here, where the admin sees the message, rather than quietly producing a
 * WhatsApp link that does not work.
 */
const officePhone = (value: unknown, label: string) => {
   const text = officeText(value, label, 40)
   if (!text) return ''
   const compact = text.replace(/[\s.\-()]/g, '')
   if (!/^\+?[1-9]\d{7,14}$/.test(compact)) {
      throw new AppError(`${label} must be an international number, for example +243 81 000 00 00`, 400)
   }
   return compact
}

export const parseOffices = (input: unknown) => {
   if (input === undefined) return undefined
   if (!Array.isArray(input)) throw new AppError('offices must be a list', 400)
   if (input.length > MAX_OFFICES) {
      throw new AppError(`At most ${MAX_OFFICES} offices can be listed`, 400)
   }
   const offices = input.map((o: any, i: number) => {
      const label = `Office ${i + 1}`
      if (!o || typeof o !== 'object' || Array.isArray(o)) {
         throw new AppError(`${label} is not an office`, 400)
      }
      const name = officeText(o.name, `${label} name`, 80)
      const city = officeText(o.city, `${label} city`, 80)
      if (!name || !city) throw new AppError(`${label} needs a name and a city`, 400)
      return {
         // Keep the id of an office that already exists, so edits stay edits.
         ...(isValidObjectId(o.id) ? { _id: String(o.id) } : {}),
         name,
         city,
         streetAddress: officeText(o.streetAddress, `${label} address`, 200),
         phone: officePhone(o.phone, `${label} phone`),
         whatsapp: officePhone(o.whatsapp, `${label} WhatsApp`),
         email: officeText(o.email, `${label} email`, 200),
         hours: officeText(o.hours, `${label} hours`, 200),
         geo: parseGeo(o.geo) ?? undefined,
         isPrimary: o.isPrimary === true,
      }
   })
   // One document per id: a repeated id would be two offices under one _id.
   const ids = offices.map((o: any) => o._id).filter(Boolean)
   if (new Set(ids).size !== ids.length) throw new AppError('Two offices share an id', 400)

   const primary = Math.max(offices.findIndex((o) => o.isPrimary), 0)
   offices.forEach((o, i) => (o.isPrimary = i === primary))
   return offices
}

/** §1.3: settings changes require step-up re-auth (enforced at the route). */
export const updateSettings = catchAsync(async (req: Request, res: Response) => {
   const settings = await getSettings()
   const before = settings.toObject()

   // Validated here, because the copy below writes whatever the body carries.
   if (req.body.offices !== undefined) req.body.offices = parseOffices(req.body.offices)

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
      // §BUG-018: a test send must go to a real E.164 number — reject anything
      // else before it reaches the provider.
      if (!/^\+[1-9]\d{6,14}$/.test(to)) {
         return next(
            new AppError('Enter the number in international format, e.g. +243970000000', 400)
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
         // §BUG-018: the raw provider/Twilio text (error codes, account state,
         // sender ids) is logged server-side but never echoed to the client.
         const raw = (err as Error).message
         console.error(`[notify:test] send to ${to} failed: ${raw}`)
         await NotificationLog.create({
            event: event || 'TEST',
            channel: 'SMS',
            recipient: to,
            status: 'FAILED',
            providerMessage: raw.slice(0, 300),
         })
         return next(
            new AppError('Could not send the test message. Check the number and try again.', 502)
         )
      }
   }
)
