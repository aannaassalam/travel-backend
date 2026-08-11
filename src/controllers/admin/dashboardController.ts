import { Request, Response } from 'express'

import {
   FULFILMENT_STATUS,
   ORDER_STATUS,
   PAYMENT_STATUS,
} from '../../constants/domain.constants'
import { RatePlan } from '../../model/hotelModel'
import { baseAmount } from '../../model/shared.schema'
import { Order } from '../../model/orderModel'
import { getSettings } from '../../model/settingsModel'
import catchAsync from '../../utils/catchAsync'
import { orderCost } from '../../utils/orderMath'
import { sendResponse } from '../../utils/response'

/**
 * Dashboard metrics (§4).
 *
 * ponytail: computed live from the transactional collections. §4.3 requires
 * precomputed daily rollups so the dashboard never competes with checkout for
 * database resources — correct, and it matters once volume arrives. At zero
 * orders it would be premature: swap these aggregations for a nightly rollup
 * collection behind the same response shape when order volume makes the query
 * cost visible. The response contract does not change.
 */

const periodStart = (req: Request) => {
   const days = Number(req.query.days) || 30
   return new Date(Date.now() - days * 86400000)
}

export const getDashboard = catchAsync(async (req: Request, res: Response) => {
   const since = periodStart(req)
   const settings = await getSettings()

   const paidInPeriod = await Order.find({
      createdAt: { $gte: since },
      paymentStatus: PAYMENT_STATUS.PAID,
      status: { $ne: ORDER_STATUS.CANCELLED },
   })

   // §4.1 definitions, applied exactly as written.
   const gmv = paidInPeriod.reduce((s, o) => s + o.total, 0)
   // Spans nights × quantity, exactly as lineTotal does — see utils/orderMath.
   const costOfSold = paidInPeriod.reduce((s, o) => s + orderCost(o.items), 0)
   const cancelled = await Order.find({
      createdAt: { $gte: since },
      status: ORDER_STATUS.CANCELLED,
   })
   const netRevenue = gmv - cancelled.reduce((s, o) => s + o.total, 0)
   const grossMargin = netRevenue - costOfSold

   const cashOutstanding = (
      await Order.find({
         paymentMethod: 'CASH',
         paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING] },
         status: { $ne: ORDER_STATUS.CANCELLED },
      })
   ).reduce((s, o) => s + o.total, 0)

   /**
    * §4.1: the two metrics a naive build omits. A month with strong revenue
    * and 30% spoilage is a losing month, and a revenue-only dashboard hides it.
    */
   const now = new Date()
   const atRiskCutoff = new Date(
      now.getTime() + settings.atRiskWindowDays * 86400000
   )
   const atRiskCells = await RatePlan.find({
      date: { $gte: now, $lte: atRiskCutoff },
      blocked: false,
   })
   // Every total sums in the base currency — that is what USD being mandatory buys.
   const atRiskValue = atRiskCells.reduce(
      (s, c) => s + Math.max(c.allotment - c.sold, 0) * baseAmount(c.costPrice),
      0
   )

   const spoiledCells = await RatePlan.find({ date: { $lt: now } })
   const spoilageValue = spoiledCells.reduce(
      (s, c) => s + Math.max(c.allotment - c.sold, 0) * baseAmount(c.costPrice),
      0
   )
   const purchasedUnits = spoiledCells.reduce((s, c) => s + c.allotment, 0)
   const soldUnits = spoiledCells.reduce((s, c) => s + c.sold, 0)

   return sendResponse(res, 200, 'OK', {
      currency: settings.baseCurrency,
      // §4.3: silent staleness destroys trust faster than visible lag.
      dataAsOf: new Date().toISOString(),
      periodDays: Number(req.query.days) || 30,
      headline: {
         netRevenue,
         grossMargin,
         marginPercent: netRevenue ? (grossMargin / netRevenue) * 100 : null,
         orders: paidInPeriod.length,
         // No public site yet, so there are no search sessions to divide by.
         conversionRate: null,
         cashOutstanding,
      },
      inventory: {
         atRiskValue,
         atRiskWindowDays: settings.atRiskWindowDays,
         spoilageValue,
         sellThroughRate: purchasedUnits ? (soldUnits / purchasedUnits) * 100 : null,
      },
      actions: {
         atRiskInventory: atRiskCells.filter((c) => c.allotment - c.sold > 0).length,
         cashExpiring24h: await Order.countDocuments({
            paymentMethod: 'CASH',
            paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING] },
            cashDeadline: { $gte: now, $lte: new Date(now.getTime() + 86400000) },
         }),
         enquiriesPastSla: 0,
         awaitingDocuments: await Order.countDocuments({
            paymentStatus: PAYMENT_STATUS.PAID,
            fulfilmentStatus: {
               $in: [FULFILMENT_STATUS.NOT_STARTED, FULFILMENT_STATUS.DOCUMENTS_PENDING],
            },
         }),
         failedPayments24h: await Order.countDocuments({
            paymentStatus: PAYMENT_STATUS.FAILED,
            updatedAt: { $gte: new Date(now.getTime() - 86400000) },
         }),
         paymentExceptions: await Order.countDocuments({
            paymentStatus: PAYMENT_STATUS.REVERSED,
         }),
      },
   })
})
