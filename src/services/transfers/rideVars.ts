/**
 * What a ride contributes to a notification: the template variables, and the
 * links each party opens. No imports, so both the notification service and the
 * ride lifecycle can use it without importing each other.
 */

/** A stored wall-clock time as "YYYY-MM-DD HH:MM", as written (no zone). */
export const wallClock = (d?: Date | string | null) =>
   d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : ''

/** "Toyota Corolla blanche · KN 1234 AB". */
export const vehicleLabel = (v?: { make?: string; model?: string; color?: string; plate?: string } | null) =>
   v ? [[v.make, v.model, v.color].filter(Boolean).join(' '), v.plate].filter(Boolean).join(' · ') : ''

const siteBase = () => (process.env.PUBLIC_SITE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '')

/** The driver portal: its home, or one ride's page. */
export const driverPortalLink = (reference?: string) =>
   siteBase() ? `${siteBase()}/driver${reference ? `/rides/${reference}` : ''}` : ''

/** The admin's page for a ride, when ADMIN_URL is set. */
export const adminRideLink = (rideId: unknown) => {
   const base = (process.env.ADMIN_URL || '').replace(/\/$/, '')
   return base ? `${base}/transfers/rides/${rideId}` : ''
}

export const rideVars = (
   ride: {
      reference?: string
      mode?: string
      hours?: number
      at?: Date
      pickup?: { label?: string }
      dropoff?: { label?: string }
      customerName?: string
      customerPhone?: string
   },
   driver?: { name?: string; phone?: string } | null,
   vehicle?: { make?: string; model?: string; color?: string; plate?: string } | null
) => ({
   order_ref: ride.reference ?? '',
   pickup: ride.pickup?.label ?? '',
   dropoff: ride.dropoff?.label ?? (ride.mode === 'HOURLY' && ride.hours ? `${ride.hours} h à disposition` : ''),
   departure_date: wallClock(ride.at),
   driver_name: driver?.name ?? '',
   driver_phone: driver?.phone ?? '',
   vehicle: vehicleLabel(vehicle),
   customer_name: ride.customerName ?? '',
   customer_phone: ride.customerPhone ?? '',
})
