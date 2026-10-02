import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import { Types } from 'mongoose'
import {
   BASE_CURRENCY,
   FULFILMENT_STATUS,
   ORDER_STATUS,
   PAYMENT_METHOD,
   PAYMENT_STATUS,
   VERTICALS,
} from '../../constants/domain.constants'
import { currentDocuments, presentOrder } from '../../dto/public/order.dto'
import { storage } from '../../services/storage'
import { Customer } from '../../model/customerModel.admin'
import { Order } from '../../model/orderModel'
import { Restaurant } from '../../model/restaurantModel'
import { PolicyVersion, getSettings } from '../../model/settingsModel'
import {
   commitListing,
   commitStay,
   holdListing,
   holdStay,
   releaseListing,
   releaseStay,
} from '../../services/orders/inventory.service'
import {
   PricedItem,
   RequestedItem,
   priceDelivery,
   priceItem,
   settle,
} from '../../services/orders/pricing.service'
import { currentCustomer } from '../../middleware/customerAuth'
import { notifyOrder } from '../../services/notifications/notify.service'
import { NOTIFICATION_EVENTS } from '../../model/enquiryModel'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Public checkout. Three routes: create an order, read one back, pay for one.
 *
 * What the client is trusted with: which product, how many, which dates, who is
 * travelling, and how it wants to pay. What it is NOT trusted with: any price,
 * any status, or whether stock exists. All four are decided here (§5, §4.5).
 */

/**
 * §10.3(4): unguessable, never sequential. The reference is also the read
 * capability for `GET /orders/:reference`, so it carries ~50 bits of entropy —
 * while staying short enough to read down a phone line (§3), which is the job
 * it actually has to do in an office in Kinshasa.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32: no I, L, O, U
const makeReference = () => {
   const bytes = crypto.randomBytes(10)
   let out = ''
   for (let i = 0; i < 10; i++) out += ALPHABET[bytes[i] % 32]
   return `FA-${out.slice(0, 5)}-${out.slice(5)}`
}

/**
 * Creates the order, re-rolling the reference if it ever collides.
 *
 * The odds barely justify the code - 2^50 of keyspace puts the chance of ANY
 * collision at roughly 1 in 2,252 across a million bookings - but `reference`
 * is a unique index, so a collision does not merge two orders: it throws
 * E11000 and the customer's checkout fails. Their stock is already held at that
 * point, so the failure costs them the booking and us the sale, for something
 * a second attempt fixes outright.
 *
 * Only duplicate-key errors are retried. Anything else is a real fault and is
 * rethrown immediately rather than attempted three times.
 */
const createWithReference = async (doc: Record<string, unknown>) => {
   for (let attempt = 0; attempt < 3; attempt++) {
      try {
         return await Order.create({ ...doc, reference: makeReference() })
      } catch (err: any) {
         const duplicateReference =
            err?.code === 11000 && Object.keys(err?.keyPattern ?? {}).includes('reference')
         if (!duplicateReference || attempt === 2) throw err
      }
   }
   // Unreachable: the loop either returns or throws.
   throw new AppError('Could not allocate a booking reference', 500)
}

/** Same shape the customer realm already uses (customerAuthController.updateMe). */
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** §7.2: one canonical form, or "the same customer" stops meaning anything. */
const normalisePhone = (raw: string) => {
   const trimmed = String(raw ?? '').replace(/[\s.-]/g, '')
   if (/^\+\d{8,15}$/.test(trimmed)) return trimmed
   if (/^0\d{8,12}$/.test(trimmed)) return `+243${trimmed.slice(1)}`
   if (/^\d{8,15}$/.test(trimmed)) return `+${trimmed}`
   return null
}

/** Undo every hold taken so far. Used when a later step fails. */
const rollback = async (taken: { item: PricedItem; nights: Types.ObjectId[] }[]) => {
   for (const t of taken) {
      if (t.nights.length) await releaseStay(t.nights, t.item.quantity)
      else await releaseListing(t.item.listingId, t.item.quantity)
   }
}

// ---------------------------------------------------------------------------
// POST /orders
// ---------------------------------------------------------------------------

export const createOrder = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const key = req.header('Idempotency-Key')
      if (!key) return next(new AppError('Idempotency-Key header is required', 400))

      /**
       * §BUG-009: the caller this key belongs to — the signed-in customer, else
       * the normalised phone they typed. A key is only a replay for the SAME
       * caller; resolved here so it can gate the replay below.
       */
      const signedIn = await currentCustomer(req)
      const idempotencyScope =
         (signedIn
            ? String(signedIn._id)
            : normalisePhone(req.body?.contact?.phone ?? '')) || undefined

      /**
       * §4.6: a dropped response on a mobile network gets retried, and a
       * duplicate order double-books stock and double-charges a customer. The
       * key is stored on the order, so the replay returns the original rather
       * than creating a second one.
       */
      const replay = await Order.findOne({ idempotencyKey: key })
      if (replay) {
         /**
          * §BUG-009: scoped replay. A key already spent by another caller is
          * unusable, never a window onto that caller's order. (Legacy orders with
          * no stored scope fall through to the existing behaviour.)
          */
         if (replay.idempotencyScope && replay.idempotencyScope !== idempotencyScope) {
            return next(
               new AppError('Idempotency key already used', 409, 'IDEMPOTENCY_KEY_USED')
            )
         }
         /**
          * A replay is only a replay while the original is alive. Handing back
          * a CANCELLED order with a 200 "already created" is how a customer's
          * genuinely new booking got silently swapped for a dead one — the
          * client reused its key, we returned the corpse, and the very next
          * call (/pay) refused it with a 409 that looked like it came from
          * nowhere. The key is unique-indexed, so the honest answer is: this
          * attempt is spent, start a new one. ORDER_CANCELLED is the code the
          * clients already turn into a "take the booking again" action.
          */
         if (replay.status === ORDER_STATUS.CANCELLED) {
            return next(
               new AppError(
                  'That booking attempt expired. Please start again.',
                  409,
                  'ORDER_CANCELLED'
               )
            )
         }
         /**
          * Same key, different currency — so this is not the request the
          * original order answered.
          *
          * An order is priced once and `chargedCurrency` is frozen on it. A
          * client that switched currency and reused its key would get the old
          * order back with a 200, and be sent to pay in the currency it had
          * just changed away from. Replaying the wrong currency is worse than
          * refusing: it is a customer charged in a currency they did not
          * choose. Clients mint a fresh key on a currency change; this is the
          * backstop for the ones that do not.
          */
         const wanted = String(req.body?.currency ?? '').toUpperCase()
         if (wanted && replay.chargedCurrency && wanted !== replay.chargedCurrency) {
            return next(
               new AppError(
                  'That booking was priced in a different currency. Please start again.',
                  409,
                  'CURRENCY_CHANGED'
               )
            )
         }
         return sendResponse(res, 200, 'Order already created', { order: presentOrder(replay) })
      }

      const { items, contact, travellers = [], paymentMethod, currency, locale } = req.body ?? {}

      if (!Array.isArray(items) || !items.length) {
         return next(new AppError('At least one item is required', 400))
      }
      if (items.length > 10) return next(new AppError('Too many items', 400))
      if (!contact?.firstName || !contact?.lastName) {
         return next(new AppError('Contact first and last name are required', 400))
      }
      const phone = normalisePhone(contact.phone)
      if (!phone) return next(new AppError('A valid phone number is required', 400))
      // §BUG-014: an invalid e-mail is refused when one is given (names are
      // capped to 80 where they are stored, below and on the customer record).
      if (contact.email && !EMAIL_RX.test(String(contact.email).trim().toLowerCase())) {
         return next(new AppError('That email address is not valid', 400))
      }

      /**
       * §BUG-014: travellers are stored almost verbatim, so each is validated
       * here. A name that is not a non-empty string (an object or array) is how a
       * query operator gets smuggled into a stored document; a `enc:v1:`
       * documentNumber is client-supplied ciphertext we must never store; a
       * future date of birth is nonsense.
       */
      const travellerList = (Array.isArray(travellers) ? travellers : [])
         .filter((t: any) => t && typeof t === 'object' && !Array.isArray(t))
         .filter((t: any) => t.firstName || t.lastName)
         .slice(0, 20)
      const endOfToday = new Date()
      endOfToday.setHours(23, 59, 59, 999)
      for (const t of travellerList) {
         if (
            typeof t.firstName !== 'string' ||
            !t.firstName.trim() ||
            typeof t.lastName !== 'string' ||
            !t.lastName.trim()
         ) {
            return next(new AppError('Each traveller needs a first and last name', 400))
         }
         if (t.dateOfBirth !== undefined && t.dateOfBirth !== null && t.dateOfBirth !== '') {
            const dob = new Date(t.dateOfBirth).getTime()
            if (Number.isNaN(dob) || dob > endOfToday.getTime()) {
               return next(new AppError('A traveller date of birth is not valid', 400))
            }
         }
         if (typeof t.documentNumber === 'string' && t.documentNumber.startsWith('enc:v1:')) {
            return next(new AppError('Invalid document number', 400))
         }
      }

      /**
       * Product decision 2026-10-02: cash only in every environment. A request
       * for any other method is refused outright, not silently booked as cash —
       * the client must show the customer the right thing, not guess.
       */
      if (paymentMethod && paymentMethod !== PAYMENT_METHOD.CASH) {
         return next(new AppError('Only cash payment is available.', 400, 'CASH_ONLY'))
      }
      const method = PAYMENT_METHOD.CASH

      // --- 1. Re-price from the database ------------------------------------
      let priced: PricedItem[]
      try {
         priced = await Promise.all(
            (items as RequestedItem[]).map((i) => {
               const quantity = Number(i.quantity)
               if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
                  throw new Error('INVALID_QUANTITY')
               }
               return priceItem({ ...i, quantity })
            })
         )
      } catch (err) {
         const code = (err as Error).message
         if (code === 'PROPERTY_IS_ENQUIRY_ONLY') {
            // §1.1 archetype C: property has no checkout at all.
            return next(new AppError('This listing is enquiry-only', 400))
         }
         if (code === 'INVALID_QUANTITY') return next(new AppError('Invalid quantity', 400))
         // §BUG-008: bad/reversed/past/over-long dates are a 400, not a 409.
         if (code === 'INVALID_DATES') {
            return next(new AppError('Those dates are not valid', 400))
         }
         return next(new AppError('One of these items is no longer available', 409))
      }

      if (priced.some((p) => p.lineTotal <= 0)) {
         return next(new AppError('One of these items is not priced for sale', 409))
      }

      /**
       * --- 1b. Restaurant orders: one kitchen, one address ------------------
       *
       * A delivery order is one driver leaving one restaurant with one bag. Two
       * kitchens in an order has no meaning — there is no second driver and no
       * second fee — so it is refused here rather than half-honoured later.
       * Mixing a dish with a flight seat is the same problem.
       */
      const foodLines = priced.filter((p) => p.vertical === VERTICALS.RESTAURANT)
      let deliveryLine: PricedItem | null = null
      let deliveryDoc: Record<string, unknown> | null = null

      if (foodLines.length) {
         if (foodLines.length !== priced.length) {
            return next(new AppError('Food cannot be ordered alongside travel', 400))
         }
         if (new Set(foodLines.map((p) => String(p.listingId))).size > 1) {
            return next(new AppError('One order can only come from one restaurant', 400))
         }

         const delivery = req.body?.delivery
         const address = String(delivery?.address ?? '').trim()
         if (!address) return next(new AppError('A delivery address is required', 400))

         const restaurant = await Restaurant.findOne({
            _id: foodLines[0].listingId,
            status: 'PUBLISHED',
         })
         if (!restaurant) return next(new AppError('That restaurant is not taking orders', 409))

         /**
          * The zone is read off the restaurant, never taken from the request. A
          * posted fee is a fee chosen by whoever is driving the browser, which
          * is the same reason every line price is re-read above.
          */
         const zone = (restaurant.deliveryZones ?? []).find(
            (z: any) => String(z._id) === String(delivery?.zoneId) && z.isActive
         )
         if (!zone) return next(new AppError('Choose a delivery zone we cover', 400))

         // Minimum is on the food, not the food plus the fee — otherwise the
         // delivery charge helps you clear the bar it exists to enforce.
         const foodUsd = foodLines.reduce((sum, l) => sum + l.lineTotal, 0)
         const minOrder = (zone.minOrder as any)?.[BASE_CURRENCY] ?? 0
         if (minOrder && foodUsd < minOrder) {
            return next(new AppError('Order is below the minimum for that zone', 400))
         }

         deliveryLine = priceDelivery(zone, restaurant.displayName())
         deliveryDoc = {
            address: address.slice(0, 300),
            zoneId: zone._id,
            zoneName: zone.name,
            etaMinutes: (restaurant.prepTimeMinutes ?? 0) + (zone.etaMinutes ?? 0),
            notes: String(delivery?.notes ?? '').trim().slice(0, 300) || undefined,
         }
      }

      // --- 2. Hold the stock ------------------------------------------------
      const taken: { item: PricedItem; nights: Types.ObjectId[] }[] = []
      for (const item of priced) {
         /**
          * Dishes have no allotment to hold. A kitchen is not a seat map: it
          * either can cook the dish today or it cannot, which `isAvailable`
          * already answered when the line was priced. Calling holdListing here
          * would decrement a counter that does not exist and fail every
          * restaurant order.
          */
         if (item.vertical === VERTICALS.RESTAURANT) {
            taken.push({ item, nights: [] })
            continue
         }
         if (item.vertical === VERTICALS.HOTEL && item.roomTypeId) {
            const { ok, held } = await holdStay(
               item.roomTypeId,
               item.startDate!,
               item.endDate!,
               item.quantity
            )
            if (!ok) {
               await rollback(taken)
               return next(new AppError('Those dates just sold out', 409))
            }
            taken.push({ item, nights: held })
         } else {
            const ok = await holdListing(item.listingId, item.quantity)
            if (!ok) {
               await rollback(taken)
               return next(new AppError('That just sold out', 409))
            }
            taken.push({ item, nights: [] })
         }
      }

      try {
         // The locale the customer is actually being served, used for both the
         // customer record and the consent snapshot below.
         const wanted = ['fr', 'en'].includes(locale) ? locale : 'fr'

         // --- 3. Customer, merged on the canonical phone (§7.2) --------------
         /**
          * `firstName` / `lastName` — the schema has no `name` field, and its
          * `fullName` is a virtual. Writing `name` here is silently discarded
          * by strict mode, and because `findOneAndUpdate` does not run
          * validators on upsert, the required `firstName` would not complain
          * either: every checkout would quietly file a nameless customer.
          */
         /**
          * §BUG-002: identity fields go in `$setOnInsert`, never `$set`. A guest
          * checkout must NOT rewrite the name/email of an existing customer who
          * happens to share this phone — the guest's own contact details already
          * live on the order. On insert these seed a brand-new contact record.
          */
         const onInsert: Record<string, unknown> = {
            phone,
            locale: wanted,
            hasAccount: false,
            firstName: String(contact.firstName).trim().slice(0, 80),
            lastName: String(contact.lastName).trim().slice(0, 80),
         }
         if (contact.email) onInsert.email = String(contact.email).toLowerCase()

         /**
          * A guest checkout files a CONTACT, never an account.
          *
          * The office has to know who booked, so the customer record is always
          * written — but `hasAccount` is left exactly as it was. Signing someone
          * in because they bought something would hand whoever is holding the
          * phone a session nobody proved they owned, and would silently claim a
          * number that may belong to somebody else entirely. An account is only
          * ever created by verifying a one-time code (§7.2).
          *
          * A signed-in customer is matched by session, not by the phone typed
          * into the form, so they cannot attach an order to someone else.
          */
         const customer = signedIn?.phone === phone
            ? signedIn
            : await Customer.findOneAndUpdate(
                 { phone },
                 { $setOnInsert: onInsert },
                 { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
              )

         /**
          * §BUG-002 (attachment): an order is never filed into an account the
          * caller has not proved they own. A guest — or a signed-in customer
          * typing somebody else's number — whose phone resolves to a registered
          * account is told to sign in, instead of that account silently gaining
          * an order it did not place.
          */
         if (customer.hasAccount && String(customer._id) !== String(signedIn?._id ?? '')) {
            // throw, never `return next(...)`: we are inside the try whose catch
            // releases the stock held above — a plain return leaks the hold.
            throw new AppError(
               'This number belongs to an account. Please sign in to book.',
               409,
               'ACCOUNT_EXISTS'
            )
         }

         // --- 4. Consent evidence (§2.2) ------------------------------------
         /**
          * Read from the live policy version rather than a constant, so the text
          * captured is provably the text the content section had published. The
          * id is stored alongside the snapshot: the snapshot is what defends a
          * chargeback, the id is what ties it to the immutable version record.
          */
         const policy =
            (await PolicyVersion.findOne({ kind: 'NO_REFUND', locale: wanted, isLive: true })) ??
            (await PolicyVersion.findOne({ kind: 'NO_REFUND', locale: 'fr', isLive: true }))
         if (!policy) {
            throw new AppError('No published no-refund policy — cannot take an order', 503)
         }

         const { chargedCurrency, chargedTotal, fxRate, totalUsd } = settle(
            // The fee settles with the food, not after it: a fee typed only in
            // USD means the order cannot honestly settle in CDF, exactly as a
            // dish priced only in USD cannot. Added afterwards it would either
            // be converted (§5 forbids it) or charged in the wrong currency.
            deliveryLine ? [...priced, deliveryLine] : priced,
            currency
         )
         const settings = await getSettings()
         const isCash = method === PAYMENT_METHOD.CASH

         const order = await createWithReference({
            idempotencyKey: key,
            idempotencyScope,
            /**
             * §4.3 three independent axes, never merged. A cash order is
             * SUBMITTED / UNPAID / NOT_STARTED — it exists and is owed, which is
             * exactly the state the chase list queries.
             */
            status: ORDER_STATUS.SUBMITTED,
            paymentStatus: PAYMENT_STATUS.UNPAID,
            fulfilmentStatus: FULFILMENT_STATUS.NOT_STARTED,
            customer: customer._id,
            items: priced.map((p) => ({
               vertical: p.vertical,
               listingId: p.listingId,
               listingLabel: p.listingLabel,
               roomTypeId: p.roomTypeId,
               startDate: p.startDate,
               endDate: p.endDate,
               quantity: p.quantity,
               unitSellPrice: p.unitSellPrice,
               unitCostPrice: p.unitCostPrice,
               lineTotal: p.lineTotal,
               lineCost: p.lineCost,
            })),
            travellers: travellerList,
            total: totalUsd,
            chargedCurrency,
            chargedTotal,
            fxRate,
            paymentMethod: method,
            channel: 'WEB',
            cashDeadline: isCash
               ? new Date(Date.now() + settings.holdTtlCashHours * 3600_000)
               : new Date(Date.now() + settings.holdTtlOnlineMinutes * 60_000),
            consent: {
               policyVersionId: policy._id,
               policyVersionLabel: policy.label,
               textShown: policy.body,
               locale: wanted,
               acceptedAt: new Date(),
               ip: req.ip,
               userAgent: req.header('User-Agent')?.slice(0, 300),
            },
            delivery: deliveryDoc
               ? {
                    ...deliveryDoc,
                    fee: deliveryLine!.lineTotal,
                    // Falls back to the base amount when the order settled in
                    // USD, so this is never blank on a real order.
                    feeCharged:
                       deliveryLine!.lineTotalByCurrency[chargedCurrency] ??
                       deliveryLine!.lineTotal,
                 }
               : undefined,
            travelDate: priced.find((p) => p.startDate)?.startDate,
            timeline: [{ event: 'ORDER_CREATED', detail: `channel=WEB method=${method}` }],
         })

         // The held rate-plan ids live on the order so payment can commit
         // exactly what was held, without recomputing the date range.
         if (taken.some((t) => t.nights.length)) {
            await Order.updateOne(
               { _id: order._id },
               { $set: { heldRatePlanIds: taken.flatMap((t) => t.nights) } }
            )
         }

         /**
          * Only an order collected off-platform is told about at creation.
          *
          * For cash and bank transfer the SMS IS the payment instruction — the
          * reference and the link are what the customer brings to the office —
          * so it has to go out now, before any money moves.
          *
          * An online order is different: the payment page is already in front
          * of the customer, and nothing is settled until the provider says so.
          * Sending "your booking is registered" here meant every abandoned
          * checkout got a paid-for SMS about an order that would auto-cancel
          * twenty minutes later, and a customer who never paid held a message
          * that read like a confirmation. PAYMENT_RECEIVED, fired from
          * `settle()`, is the online order's first and only confirmation.
          *
          * Not awaited: a notification must never delay or fail a checkout.
          * `notifyOrder` swallows its own errors into the delivery log.
          */
         if (method === PAYMENT_METHOD.CASH) {
            void notifyOrder(NOTIFICATION_EVENTS.ORDER_CONFIRMED, order._id)
         }

         return sendResponse(res, 201, 'Order created', { order: presentOrder(order) })
      } catch (err) {
         // Never leave stock held for an order that does not exist.
         await rollback(taken)
         throw err
      }
   }
)

// ---------------------------------------------------------------------------
// GET /orders/:reference
// ---------------------------------------------------------------------------

/**
 * §7.4: the reference is the capability. It is high-entropy and unguessable, so
 * possession is the authorisation — the same model as an e-ticket link. The
 * response is identical in shape and timing whether or not a reference exists,
 * so this cannot be used to probe for valid ones.
 */
export const getOrder = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      /**
       * `documentNumber` is `select: false`, so it has to be asked for in order
       * to be MASKED — §6.2 wants "••••4321", not an absent field, which the UI
       * would render as "no document on file". The DTO has no allow-list entry
       * for the raw value, so it cannot escape; only the mask is emitted.
       */
      const order = await Order.findOne({
         reference: String(req.params.reference).toUpperCase(),
      })
         .select('+travellers.documentNumber')
         // Only for the masked confirmation line; the DTO emits nothing else.
         .populate('customer', 'phone')
      if (!order) return next(new AppError('Order not found', 404))
      return sendResponse(res, 200, 'OK', { order: presentOrder(order) })
   }
)

// ---------------------------------------------------------------------------
// GET /orders/:reference/documents/:documentId
// ---------------------------------------------------------------------------

/** Long enough to tap "download", too short to be worth passing around. */
const DOCUMENT_LINK_SECONDS = 300

/**
 * A short-lived link to one issued document.
 *
 * Authorised the same way as the order itself: the reference is the read
 * capability, which is what lets a guest — who has no login — open the ticket
 * from the link in their SMS. No URL is ever stored or returned in the order
 * payload; it is minted here, per request, and expires.
 *
 * Only the current version of each kind is served. A superseded ticket must not
 * be downloadable by id just because someone kept the old one.
 */
export const getOrderDocument = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const order = await Order.findOne({
         reference: String(req.params.reference).toUpperCase(),
      })
      const doc = order
         ? currentDocuments(order.documents).find(
              (d: any) => d._id?.toString() === String(req.params.documentId)
           )
         : null
      // One answer for "no such order" and "no such document": which
      // references exist is not something to tell a prober.
      if (!order || !doc?.storageKey) return next(new AppError('Document not found', 404))

      const link = await storage().signedUrl(
         doc.storageKey,
         DOCUMENT_LINK_SECONDS,
         doc.fileName
      )
      // The local driver answers with a path on this API; S3 with a full URL.
      const base = (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
      return sendResponse(res, 200, 'OK', {
         url: /^https?:\/\//.test(link) ? link : `${base}${link}`,
         fileName: doc.fileName,
         expiresInSeconds: DOCUMENT_LINK_SECONDS,
      })
   }
)

/*
 * The simulated `payOrder` that used to live here has been removed.
 *
 * It marked orders PAID on request, which was fine while it was scaffolding and
 * is a hole the moment real money exists. Provider payments now live in
 * controllers/public/paymentController.ts, where the only path to PAID is a
 * server-to-server status check against MaxiCash.
 */
