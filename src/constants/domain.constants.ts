/**
 * Domain vocabulary. §15 lists "free-text where an enum belongs" as something
 * that destroys reporting within weeks — every status, category and type in the
 * system resolves to one of these.
 */

export const VERTICALS = {
   FLIGHT: 'FLIGHT',
   BUS: 'BUS',
   CAR: 'CAR',
   HOTEL: 'HOTEL',
   ACTIVITY: 'ACTIVITY',
   PROPERTY: 'PROPERTY',
} as const
export type Vertical = (typeof VERTICALS)[keyof typeof VERTICALS]

/** §5.1 persistent status column. */
export const LISTING_STATUS = {
   DRAFT: 'DRAFT',
   PUBLISHED: 'PUBLISHED',
   PAUSED: 'PAUSED',
   EXPIRED: 'EXPIRED',
   SOLD_OUT: 'SOLD_OUT',
   ARCHIVED: 'ARCHIVED',
} as const
export type ListingStatus = (typeof LISTING_STATUS)[keyof typeof LISTING_STATUS]

/**
 * Money model. Prices are entered and stored in USD base (§5.1); CDF/EUR are
 * display conversions applied at read time from the FX table.
 *
 * Stored as integer minor units — 12.34 USD is 1234. Floats lose cents, and
 * §0 is explicit that a wrong decimal on a hotel rate costs real money that a
 * no-refund policy makes painful to unwind.
 */
export const BASE_CURRENCY = 'USD'
export const CURRENCIES = ['USD', 'CDF', 'EUR'] as const
export type Currency = (typeof CURRENCIES)[number]

export const ORDER_STATUS = {
   DRAFT: 'DRAFT',
   SUBMITTED: 'SUBMITTED',
   CONFIRMED: 'CONFIRMED',
   CANCELLED: 'CANCELLED',
   COMPLETED: 'COMPLETED',
} as const
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS]

export const PAYMENT_STATUS = {
   UNPAID: 'UNPAID',
   PENDING: 'PENDING',
   PAID: 'PAID',
   FAILED: 'FAILED',
   REVERSED: 'REVERSED',
} as const
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS]

export const FULFILMENT_STATUS = {
   NOT_STARTED: 'NOT_STARTED',
   DOCUMENTS_PENDING: 'DOCUMENTS_PENDING',
   DOCUMENTS_ISSUED: 'DOCUMENTS_ISSUED',
   DELIVERED: 'DELIVERED',
} as const
export type FulfilmentStatus =
   (typeof FULFILMENT_STATUS)[keyof typeof FULFILMENT_STATUS]

export const PAYMENT_METHOD = {
   ONLINE: 'ONLINE',
   CASH: 'CASH',
} as const

/**
 * §6.3: allow-listed transitions only, enforced server-side. Anything not
 * listed here is refused rather than quietly written.
 */
export const ALLOWED_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
   DRAFT: ['SUBMITTED', 'CANCELLED'],
   SUBMITTED: ['CONFIRMED', 'CANCELLED'],
   CONFIRMED: ['COMPLETED', 'CANCELLED'],
   CANCELLED: [],
   COMPLETED: [],
}

/** §6.4: fixed list. Cancellation is operational, never financial. */
export const CANCELLATION_REASONS = {
   CASH_DEADLINE_EXPIRED: 'CASH_DEADLINE_EXPIRED',
   CUSTOMER_REQUEST: 'CUSTOMER_REQUEST',
   CANNOT_DELIVER: 'CANNOT_DELIVER',
   FRAUD_OR_DUPLICATE: 'FRAUD_OR_DUPLICATE',
   OTHER: 'OTHER',
} as const

export const MEAL_PLANS = {
   ROOM_ONLY: 'ROOM_ONLY',
   BREAKFAST: 'BREAKFAST',
   HALF_BOARD: 'HALF_BOARD',
   FULL_BOARD: 'FULL_BOARD',
   ALL_INCLUSIVE: 'ALL_INCLUSIVE',
} as const

export const LOCALES = ['fr', 'en', 'pt', 'es'] as const
/** §2.3: admin UI in French by default. */
export const DEFAULT_LOCALE = 'fr'
