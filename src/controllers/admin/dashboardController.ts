import { NextFunction, Request, Response } from 'express'

import {
   FULFILMENT_STATUS,
   LISTING_STATUS,
   ORDER_STATUS,
   PAYMENT_METHOD,
   PAYMENT_STATUS,
   VERTICALS,
} from '../../constants/domain.constants'
import { Enquiry } from '../../model/enquiryModel'
import { Hotel, RatePlan } from '../../model/hotelModel'
import { Listing } from '../../model/listingModel'
import { Customer } from '../../model/customerModel.admin'
import { Order } from '../../model/orderModel'
import { Restaurant } from '../../model/restaurantModel'
import { getSettings } from '../../model/settingsModel'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { lineCost, orderCost } from '../../utils/orderMath'
import { sendResponse } from '../../utils/response'

/**
 * Dashboard metrics (§4).
 *
 * ponytail: computed live from the transactional collections, bounded by the
 * period filter. Swap for a nightly rollup collection behind the same response
 * shape once order volume makes the query cost visible.
 */

const DAY = 86400000
const PERIODS = [7, 30, 90]
const UNPAID_CASH = {
   paymentMethod: PAYMENT_METHOD.CASH,
   paymentStatus: { $in: [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING] },
   status: { $ne: ORDER_STATUS.CANCELLED },
}
const PAID_ORDER = {
   paymentStatus: PAYMENT_STATUS.PAID,
   status: { $ne: ORDER_STATUS.CANCELLED },
}
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/** Unsold stock at cost, in USD cents: max(total − sold, 0) × costPrice.USD. */
const unsoldAtCost = (total: string, sold: string) => ({
   $multiply: [
      { $max: [{ $subtract: [total, sold] }, 0] },
      { $ifNull: ['$costPrice.USD', 0] },
   ],
})

const statusCounts = async (Model: any) => {
   const rows: { _id: string; n: number }[] = await Model.aggregate([
      { $group: { _id: '$status', n: { $sum: 1 } } },
   ])
   return Object.fromEntries(rows.map((r) => [r._id, r.n])) as Record<string, number>
}

export const getDashboard = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const days = req.query.days === undefined ? 30 : Number(req.query.days)
      if (!PERIODS.includes(days)) {
         return next(new AppError('days must be one of 7, 30, 90', 400))
      }
      const now = new Date()
      // Buckets are UTC days; today is the last one.
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)))
      const prevFrom = new Date(from.getTime() - days * DAY)
      const in24h = new Date(now.getTime() + DAY)
      const settings = await getSettings()
      const riskCutoff = new Date(now.getTime() + settings.atRiskWindowDays * DAY)

      // Both windows in one bounded read; split in memory.
      const paid = await Order.find({ ...PAID_ORDER, createdAt: { $gte: prevFrom } })
         .select('total items createdAt')
         .lean()
      const current = paid.filter((o) => o.createdAt >= from)
      const previous = paid.filter((o) => o.createdAt < from)
      const sum = (os: typeof paid, f: (o: (typeof paid)[number]) => number) =>
         os.reduce((s, o) => s + f(o), 0)
      const revenue = sum(current, (o) => o.total)
      const prevRevenue = sum(previous, (o) => o.total)
      const grossMargin = revenue - sum(current, (o) => orderCost(o.items))
      const prevGrossMargin = prevRevenue - sum(previous, (o) => orderCost(o.items))

      // One bucket per day, empty days included.
      const series = Array.from({ length: days }, (_, i) => ({
         date: isoDay(new Date(from.getTime() + i * DAY)),
         revenue: 0,
         bookings: 0,
      }))
      const byDay = new Map(series.map((b) => [b.date, b]))
      const byVertical = Object.fromEntries(
         Object.values(VERTICALS).map((v) => [v, { vertical: v, bookings: 0, revenue: 0, margin: 0 }])
      )
      const listings = new Map<string, { listingLabel: string; vertical: string; units: number; revenue: number }>()
      for (const o of current) {
         const bucket = byDay.get(isoDay(o.createdAt))
         if (bucket) {
            bucket.revenue += o.total
            bucket.bookings += 1
         }
         const seen = new Set<string>()
         for (const it of o.items) {
            const v = byVertical[it.vertical]
            if (!v) continue
            if (!seen.has(it.vertical)) v.bookings += 1
            seen.add(it.vertical)
            v.revenue += it.lineTotal
            v.margin += it.lineTotal - lineCost(it)
            const key = String(it.listingId)
            const row = listings.get(key) ?? {
               listingLabel: it.listingLabel,
               vertical: it.vertical,
               units: 0,
               revenue: 0,
            }
            row.units += it.quantity
            row.revenue += it.lineTotal
            listings.set(key, row)
         }
      }

      const [
         newCustomers,
         prevNewCustomers,
         enquiriesWon,
         prevEnquiriesWon,
         [outstanding],
         expiring24h,
         [collected],
         awaitingConfirmation,
         awaitingDocuments,
         departingSoon,
         enquiriesOverdue,
         failedPayments24h,
         reversedPayments,
         hotelNightsAtRisk,
         listingsAtRisk,
         hotelStatus,
         listingStatus,
         restaurantStatus,
         [futureNights],
         [pastNights],
         [listingRisk],
      ] = await Promise.all([
         Customer.countDocuments({ createdAt: { $gte: from } }),
         Customer.countDocuments({ createdAt: { $gte: prevFrom, $lt: from } }),
         Enquiry.countDocuments({ stage: 'WON', updatedAt: { $gte: from } }),
         Enquiry.countDocuments({ stage: 'WON', updatedAt: { $gte: prevFrom, $lt: from } }),
         Order.aggregate([
            { $match: UNPAID_CASH },
            { $group: { _id: null, amount: { $sum: '$total' }, count: { $sum: 1 } } },
         ]),
         Order.countDocuments({ ...UNPAID_CASH, cashDeadline: { $gte: now, $lte: in24h } }),
         Order.aggregate([
            {
               $match: {
                  paymentMethod: PAYMENT_METHOD.CASH,
                  paymentStatus: PAYMENT_STATUS.PAID,
                  paidAt: { $gte: from },
               },
            },
            { $group: { _id: null, amount: { $sum: '$total' } } },
         ]),
         Order.countDocuments({ status: ORDER_STATUS.SUBMITTED }),
         Order.countDocuments({
            paymentStatus: PAYMENT_STATUS.PAID,
            fulfilmentStatus: {
               $in: [FULFILMENT_STATUS.NOT_STARTED, FULFILMENT_STATUS.DOCUMENTS_PENDING],
            },
         }),
         Order.countDocuments({
            status: ORDER_STATUS.CONFIRMED,
            travelDate: { $gte: now, $lte: new Date(now.getTime() + 2 * DAY) },
         }),
         Enquiry.countDocuments({
            firstContactAt: { $exists: false },
            stage: { $nin: ['WON', 'LOST'] },
            createdAt: { $lt: new Date(now.getTime() - settings.enquirySlaHours * 3600000) },
         }),
         Order.countDocuments({
            paymentStatus: PAYMENT_STATUS.FAILED,
            updatedAt: { $gte: new Date(now.getTime() - DAY) },
         }),
         Order.countDocuments({ paymentStatus: PAYMENT_STATUS.REVERSED }),
         RatePlan.countDocuments({
            date: { $gte: now, $lte: riskCutoff },
            blocked: false,
            $expr: { $gt: ['$allotment', '$sold'] },
         }),
         Listing.countDocuments({
            'attributes.departsAt': { $gte: now, $lte: riskCutoff },
            status: { $ne: LISTING_STATUS.ARCHIVED },
            $expr: { $gt: ['$quantityTotal', '$quantitySold'] },
         }),
         statusCounts(Hotel),
         statusCounts(Listing),
         statusCounts(Restaurant),
         RatePlan.aggregate([
            { $match: { date: { $gte: now, $lte: riskCutoff }, blocked: false } },
            { $group: { _id: null, value: { $sum: unsoldAtCost('$allotment', '$sold') } } },
         ]),
         RatePlan.aggregate([
            { $match: { date: { $lt: now } } },
            {
               $group: {
                  _id: null,
                  value: { $sum: unsoldAtCost('$allotment', '$sold') },
                  allotment: { $sum: '$allotment' },
                  sold: { $sum: '$sold' },
               },
            },
         ]),
         Listing.aggregate([
            {
               $match: {
                  'attributes.departsAt': { $gte: now, $lte: riskCutoff },
                  status: { $ne: LISTING_STATUS.ARCHIVED },
               },
            },
            { $group: { _id: null, value: { $sum: unsoldAtCost('$quantityTotal', '$quantitySold') } } },
         ]),
      ])

      const countStatus = (s: string) =>
         (hotelStatus[s] ?? 0) + (listingStatus[s] ?? 0) + (restaurantStatus[s] ?? 0)
      const delta = (value: number, prev: number) => ({ value, previous: prev })

      const body: Record<string, any> = {
         currency: settings.baseCurrency,
         dataAsOf: now.toISOString(),
         period: { days, from: from.toISOString(), to: now.toISOString() },
         headline: {
            revenue: delta(revenue, prevRevenue),
            bookings: delta(current.length, previous.length),
            averageBooking: delta(
               current.length ? Math.round(revenue / current.length) : 0,
               previous.length ? Math.round(prevRevenue / previous.length) : 0
            ),
            grossMargin: delta(grossMargin, prevGrossMargin),
            marginPercent: delta(
               revenue ? (grossMargin / revenue) * 100 : 0,
               prevRevenue ? (prevGrossMargin / prevRevenue) * 100 : 0
            ),
            newCustomers: delta(newCustomers, prevNewCustomers),
            enquiriesWon: delta(enquiriesWon, prevEnquiriesWon),
         },
         cash: {
            outstanding: { amount: outstanding?.amount ?? 0, count: outstanding?.count ?? 0 },
            expiring24h,
            collectedInPeriod: collected?.amount ?? 0,
         },
         series,
         byVertical: Object.values(byVertical),
         topListings: [...listings.values()].sort((a, b) => b.units - a.units).slice(0, 5),
         actions: {
            awaitingConfirmation,
            cashExpiring24h: expiring24h,
            awaitingDocuments,
            departingSoon,
            enquiriesOverdue,
            stockAtRisk: hotelNightsAtRisk + listingsAtRisk,
            failedPayments24h,
            reversedPayments,
         },
         inventory: {
            published: countStatus(LISTING_STATUS.PUBLISHED),
            draft: countStatus(LISTING_STATUS.DRAFT),
            paused: countStatus(LISTING_STATUS.PAUSED),
            atRiskValue: (futureNights?.value ?? 0) + (listingRisk?.value ?? 0),
            spoilageValue: pastNights?.value ?? 0,
            sellThroughRate: pastNights?.allotment
               ? (pastNights.sold / pastNights.allotment) * 100
               : null,
            atRiskWindowDays: settings.atRiskWindowDays,
         },
      }

      // Order rows carry customer names: only for admins who may open bookings.
      const permissions: string[] = (req as any).adminAccess?.permissions ?? []
      if (permissions.includes('orders:read')) {
         const recent = await Order.find({})
            .sort({ _id: -1 })
            .limit(8)
            .select('reference customer items total paymentStatus paymentMethod status createdAt')
            .populate('customer', 'firstName lastName')
            .lean()
         body.recentOrders = recent.map((o: any) => ({
            id: String(o._id),
            reference: o.reference,
            customerName: o.customer
               ? `${o.customer.firstName} ${o.customer.lastName ?? ''}`.trim()
               : '',
            services: [...new Set((o.items ?? []).map((i: any) => i.vertical))],
            total: o.total,
            paymentStatus: o.paymentStatus,
            paymentMethod: o.paymentMethod,
            status: o.status,
            createdAt: o.createdAt,
         }))
      }

      return sendResponse(res, 200, 'OK', body)
   }
)
