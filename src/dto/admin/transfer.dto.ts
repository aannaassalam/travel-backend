import { baseAmount } from '../../model/shared.schema'

/**
 * Admin ride DTOs. Unlike the public ones these carry the cost, the whole
 * timeline, the alerts and the customer's details — the office runs the ride.
 * §14.3 rule 2: separate from src/dto/public.
 */

const point = (p: any) =>
   p ? { label: p.label, lat: p.lat, lng: p.lng, placeId: p.placeId ? String(p.placeId) : undefined } : undefined

const populated = (v: any) => v && typeof v === 'object' && v._id !== undefined

const driverOf = (d: any) =>
   populated(d)
      ? {
           id: d._id.toString(),
           name: d.name,
           phone: d.phone,
           photo: d.photo || undefined,
           city: d.city,
           isActive: d.isActive,
           ratingStats: d.ratingStats ?? { rating: 0, count: 0 },
        }
      : undefined

const vehicleOf = (v: any) =>
   populated(v)
      ? { id: v._id.toString(), make: v.make, model: v.model, color: v.color || undefined, plate: v.plate, seats: v.seats ?? undefined }
      : undefined

/** The booking behind the ride, enough for the ride page to say how it stands and link through. */
export const presentOrderSummary = (o: any) =>
   o
      ? {
           id: o._id.toString(),
           reference: o.reference,
           status: o.status,
           paymentStatus: o.paymentStatus,
           paymentMethod: o.paymentMethod,
           total: o.total,
           chargedTotal: o.chargedTotal,
           chargedCurrency: o.chargedCurrency,
           cashDeadline: o.cashDeadline,
           customer: populated(o.customer)
              ? {
                   id: o.customer._id.toString(),
                   fullName: [o.customer.firstName, o.customer.lastName].filter(Boolean).join(' '),
                   phone: o.customer.phone,
                   email: o.customer.email,
                }
              : undefined,
        }
      : undefined

export const presentRideRow = (r: any, order?: any) => ({
   id: r._id.toString(),
   reference: r.reference,
   status: r.status,
   mode: r.mode,
   city: r.city,
   pickup: point(r.pickup),
   dropoff: point(r.dropoff),
   at: r.at,
   hours: r.hours ?? undefined,
   passengers: r.passengers,
   distanceKm: r.distanceKm,
   durationMinutes: r.durationMinutes,
   category: { id: String(populated(r.category) ? r.category._id : r.category), name: r.categoryName },
   customer: { id: String(r.customer), name: r.customerName, phone: r.customerPhone },
   driver: driverOf(r.driver),
   vehicle: vehicleOf(r.vehicle),
   /** Whole francs, as every admin figure. */
   price: baseAmount(r.price),
   cost: baseAmount(r.cost),
   alertsCount: r.alerts?.length ?? 0,
   order: order
      ? {
           id: order._id.toString(),
           reference: order.reference,
           status: order.status,
           paymentStatus: order.paymentStatus,
           paymentMethod: order.paymentMethod,
        }
      : undefined,
   createdAt: r.createdAt,
})

export const presentRideDetail = (r: any, order?: any) => ({
   ...presentRideRow(r),
   routeSource: r.routeSource,
   route: r.route ?? undefined,
   notes: r.notes || undefined,
   assignedAt: r.assignedAt,
   startedAt: r.startedAt,
   endedAt: r.endedAt,
   cancelledAt: r.cancelledAt,
   cancellationReason: r.cancellationReason,
   rating: r.rating ? { score: r.rating.score, comment: r.rating.comment || undefined, at: r.rating.at } : undefined,
   alerts: (r.alerts ?? []).map((a: any) => ({
      at: a.at,
      by: a.by,
      lat: a.lat ?? undefined,
      lng: a.lng ?? undefined,
      note: a.note || undefined,
      smsSent: a.smsSent,
      mapsLink: typeof a.lat === 'number' && typeof a.lng === 'number' ? `https://maps.google.com/?q=${a.lat},${a.lng}` : undefined,
   })),
   timeline: (r.timeline ?? []).map((t: any) => ({ at: t.at, event: t.event, actor: t.actor, detail: t.detail })),
   order: presentOrderSummary(order),
})
