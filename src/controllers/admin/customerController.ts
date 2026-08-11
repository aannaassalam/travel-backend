import { NextFunction, Request, Response } from 'express'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import {
   presentCustomer,
   presentCustomerList,
   presentOrderList,
} from '../../dto/admin/order.dto'
import { Customer } from '../../model/customerModel.admin'
import { Order } from '../../model/orderModel'
import { getSettings } from '../../model/settingsModel'
import { paginate, updateDoc } from '../../services/adminCrud.service'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

export const listCustomers = catchAsync(async (req: Request, res: Response) => {
   const q = req.query.q ? String(req.query.q) : ''
   const filter: Record<string, any> = {}
   if (q) {
      // §8: searchable by phone (primary), name, email.
      filter.$or = [
         { phone: { $regex: q, $options: 'i' } },
         { firstName: { $regex: q, $options: 'i' } },
         { lastName: { $regex: q, $options: 'i' } },
         { email: { $regex: q, $options: 'i' } },
      ]
   }
   const { items, nextCursor } = await paginate(Customer, filter, req)
   return sendResponse(res, 200, 'OK', {
      // Phones masked in the list (§8) — a screenshot must not be a database.
      items: presentCustomerList(items as any),
      nextCursor,
   })
})

export const getCustomer = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const customer = await Customer.findById(req.params.id)
      if (!customer) return next(new AppError('Customer not found', 404))

      const orders = await Order.find({ customer: customer._id })
         .sort({ _id: -1 })
         .limit(50)

      // §8: lifetime value.
      const lifetimeValue = orders
         .filter((o) => o.paymentStatus === 'PAID')
         .reduce((sum, o) => sum + o.total, 0)

      return sendResponse(res, 200, 'OK', {
         customer: presentCustomer(customer),
         orders: presentOrderList(orders),
         lifetimeValue,
      })
   }
)

export const updateCustomer = catchAsync(async (req: Request, res: Response) => {
   const customer = await updateDoc<any>(
      req,
      Customer,
      req.params.id,
      {
         firstName: req.body.firstName,
         lastName: req.body.lastName,
         email: req.body.email,
         phone: req.body.phone,
         city: req.body.city,
         internalNotes: req.body.internalNotes,
         isBlocked: req.body.isBlocked,
      },
      { entityType: 'Customer' }
   )
   return sendResponse(res, 200, 'Customer updated', {
      customer: presentCustomer(customer),
   })
})

/**
 * §8 / §14.4: bulk customer export. This is the most valuable dataset in the
 * system to an attacker and the most likely thing to walk out of the building.
 *
 * Route-level middleware already enforces step-up re-authentication. Here the
 * export is bounded by the configured cap, logged, and alerted out-of-band.
 *
 * ponytail: returns rows inline, bounded by the cap. §14.4 wants this queued
 * with a 15-minute signed single-use link and a watermark — that needs a job
 * runner and object storage, neither of which is chosen yet (storage was
 * dropped with Azure). The cap, the log and the alert are the controls that
 * matter most and they are live now.
 */
export const exportCustomers = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const settings = await getSettings()
      const cap = settings.customerExportRowCap

      const total = await Customer.countDocuments()
      if (total > cap) {
         return next(
            new AppError(
               `Export would return ${total} rows, above the configured cap of ${cap}. Narrow the export or raise the cap in Settings.`,
               400
            )
         )
      }

      const customers = await Customer.find().limit(cap)

      await recordAudit(req, {
         action: AUDIT_ACTIONS.CUSTOMER_EXPORTED,
         entityType: 'Customer',
         reason: req.body.reason,
         after: { rows: customers.length, cap },
      })

      return sendResponse(res, 200, `${customers.length} customer(s) exported`, {
         rows: customers.map((c) => ({
            id: c._id.toString(),
            fullName: [c.firstName, c.lastName].filter(Boolean).join(' '),
            phone: c.phone,
            email: c.email,
            city: c.city,
            createdAt: c.createdAt,
         })),
         exportedAt: new Date().toISOString(),
         // §14.4: watermark so a leaked file is traceable to a session.
         watermark: `${(req as any).admin?.email} · session ${(req as any).adminSessionId}`,
      })
   }
)
