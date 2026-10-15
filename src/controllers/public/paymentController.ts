import { NextFunction, Request, Response } from 'express'
import {
   onlinePaymentsEnabled,
   ORDER_STATUS,
   OFFLINE_RAILS,
   PAYMENT_METHOD,
   PAYMENT_RAIL,
   PAYMENT_STATUS,
   PaymentRail,
   Currency,
} from '../../constants/domain.constants'
import { presentOrder } from '../../dto/public/order.dto'
import { Order } from '../../model/orderModel'
import { getSettings } from '../../model/settingsModel'
import { again, askMaxicash, settle } from '../../services/payments/settlement.service'
import {
   SettlementOutcome,
   amountCovers,
   initializePayment,
   isToken,
   logRaw,
   maxicashEnabled,
   newToken,
   onlineCurrencies,
   parseNotification,
   paymentAwaited,
   tokenHash,
} from '../../services/payments/maxicash.service'
import { NOTIFICATION_EVENTS } from '../../model/enquiryModel'
import { notifyOrder } from '../../services/notifications/notify.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Online payments, via MaxiCash.
 *
 * The security model in one paragraph: the client may only ever ASK for a
 * payment to start. It cannot say how much, cannot say which order is paid, and
 * cannot report success. The amount comes off the order document, and
 * `settle()` (settlement.service) is the single function in the codebase that
 * can move an order to PAID — reached only from MaxiCash's call on an address
 * that was given to MaxiCash and to nobody else (see maxicash.service for why
 * the address is the proof), or from MaxiCash's own answer when this server
 * asks it about the order's reference. The customer's return from the payment
 * page, a hand-typed return address and anything else a browser can send
 * change what is shown — and may prompt this server to ask MaxiCash — never
 * what is owed.
 */

/** Whether a customer can be offered online payment right now. */
const online = () => onlinePaymentsEnabled() && maxicashEnabled()

/* -------------------------------------------------- GET /payments/options */

/**
 * What the website and the app may offer. They carry no switch of their own:
 * this server's is the only one, so they cannot offer a method it would refuse
 * — and switching online payment off here takes it off both at once.
 */
export const paymentOptions = (_req: Request, res: Response) =>
   sendResponse(res, 200, 'OK', {
      online: online(),
      /** An order priced in any other currency is paid in cash. */
      currencies: online() ? onlineCurrencies : [],
   })

/* --------------------------------------------------- POST /orders/:ref/pay */

/**
 * Starts a payment and hands back somewhere to send the customer.
 *
 * `rail` is CASH, or anything else for "online": how the customer pays online
 * is chosen on MaxiCash's page, not here.
 */
export const startPayment = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const reference = String(req.params.reference).toUpperCase()
      const order = await Order.findOne({ reference }).populate(
         'customer',
         'firstName lastName email phone'
      )
      if (!order) return next(new AppError('Order not found', 404))

      if (order.paymentStatus === PAYMENT_STATUS.PAID) {
         return sendResponse(res, 200, 'Already paid', {
            status: 'PAID',
            order: presentOrder(order),
         })
      }
      if (order.status === ORDER_STATUS.CANCELLED) {
         return next(new AppError('This order was cancelled', 409, 'ORDER_CANCELLED'))
      }

      const rail = String(req.body?.rail ?? '').toUpperCase() as PaymentRail

      // Online payment switched off: any other method is refused outright,
      // before anything below can touch the provider.
      if (!onlinePaymentsEnabled() && rail && rail !== PAYMENT_RAIL.CASH) {
         return next(new AppError('Only cash payment is available.', 400, 'CASH_ONLY'))
      }

      /**
       * Cash never reaches the provider — it is money handed over at the
       * counter — so the honest answer is the instructions, not a payment page.
       */
      if (OFFLINE_RAILS.includes(rail) || order.paymentMethod === PAYMENT_METHOD.CASH) {
         order.paymentRail = PAYMENT_RAIL.CASH
         /**
          * Cash chosen on an order that was created for online payment — after
          * a failed attempt, or on an order that straddled the cash-only
          * switch. Setting the rail alone left it an ONLINE order on the short
          * online hold: it never reached the office's cash list and was
          * auto-cancelled minutes after the customer was told to come and pay.
          * So it becomes a cash order in full, with the cash deadline and the
          * SMS that carries the reference to the counter.
          */
         const converted = order.paymentMethod !== PAYMENT_METHOD.CASH
         if (converted) {
            const settings = await getSettings()
            order.paymentMethod = PAYMENT_METHOD.CASH
            order.paymentStatus = PAYMENT_STATUS.UNPAID
            order.cashDeadline = new Date(Date.now() + settings.holdTtlCashHours * 3600_000)
            order.timeline.push({
               event: 'PAYMENT_METHOD_CHANGED',
               detail: 'ONLINE -> CASH at the customer\'s request',
            })
         }
         await order.save()
         if (converted) void notifyOrder(NOTIFICATION_EVENTS.ORDER_CONFIRMED, order._id)
         return sendResponse(res, 200, 'Settle offline', {
            status: 'OFFLINE',
            rail: order.paymentRail,
            reference: order.reference,
         })
      }

      if (!online()) {
         return next(
            new AppError('Online payment is unavailable', 503, 'PAYMENT_UNAVAILABLE')
         )
      }

      /**
       * The customer has already come back from MaxiCash by the address it
       * sends people to after a payment — or MaxiCash has said something that
       * could not be read — and its confirmation has not arrived yet. Opening
       * a second payment now is how someone pays twice.
       */
      if (paymentAwaited(order)) {
         return next(
            new AppError(
               'A payment for this booking is being confirmed.',
               409,
               'PAYMENT_BEING_CONFIRMED'
            )
         )
      }

      /**
       * A payment is already open on this order and the customer has not come
       * back from it — hand back the same page. That is what pressing Back and
       * tapping Pay again should do, and two open payments for one order is
       * how a customer ends up paying twice.
       *
       * Bounded by time: a link older than this may have expired at the
       * provider, and it is better to open a fresh one than to send someone to
       * a dead page.
       */
      const openedAt = order.payment?.initializedAt?.getTime() ?? 0
      const REUSE_WINDOW_MS = 30 * 60 * 1000
      if (
         order.payment?.paymentUrl &&
         order.paymentStatus === PAYMENT_STATUS.PENDING &&
         !order.payment.returnedAt &&
         Date.now() - openedAt < REUSE_WINDOW_MS
      ) {
         return sendResponse(res, 200, 'Payment already started', {
            status: 'REDIRECT',
            paymentUrl: order.payment.paymentUrl,
            reference: order.reference,
         })
      }

      /**
       * The amount is read off the order, in the currency the order was priced
       * in. Nothing in the request body influences it — that is the difference
       * between a checkout and a donation form.
       */
      const amountMinor = Number(order.chargedTotal ?? order.total)
      const currency = String(order.chargedCurrency ?? order.currency) as Currency

      const c: any = order.customer
      const tokens = { notify: newToken(), success: newToken(), failure: newToken() }
      const init = await initializePayment({
         reference: order.reference,
         amountMinor,
         currency,
         phone: c?.phone,
         email: c?.email,
         locale: String(req.body?.locale ?? 'fr'),
         tokens,
      })

      const settings = await getSettings()
      const now = new Date()
      // The earlier attempts stay answerable (see the model); a handful is
      // more than anyone opens.
      const attempts = [
         ...(order.payment?.attempts ?? []).map((a: any) => ({
            logId: a.logId,
            notifyHash: a.notifyHash,
            successHash: a.successHash,
            failureHash: a.failureHash,
            startedAt: a.startedAt,
         })),
         {
            logId: init.logId,
            notifyHash: tokenHash(tokens.notify),
            successHash: tokenHash(tokens.success),
            failureHash: tokenHash(tokens.failure),
            startedAt: now,
         },
      ].slice(-5)

      // How it is paid is chosen on MaxiCash's page: no rail of ours to record.
      order.paymentRail = undefined
      order.paymentStatus = PAYMENT_STATUS.PENDING
      order.set('payment', {
         provider: 'MAXICASH',
         /** MaxiCash's LogID — identifies the checkout session, not the payment. */
         transactionId: init.logId,
         merchantTransactionId: order.reference,
         paymentUrl: init.paymentUrl,
         lastStatus: 'INITIATED',
         initializedAt: now,
         attempts,
      })
      /**
       * The hold runs from now, not from when the booking was made: someone
       * who took a while over the traveller details must not have the seat
       * released while they are typing a card number.
       */
      const until = new Date(now.getTime() + settings.holdTtlOnlineMinutes * 60_000)
      if (!order.cashDeadline || order.cashDeadline < until) order.cashDeadline = until
      order.timeline.push({ event: 'PAYMENT_STARTED', detail: 'maxicash' })
      await order.save()

      /**
       * Only the URL goes back, and it carries nothing but an opaque LogID. The
       * merchant password never leaves this server — which is the whole reason
       * this integration uses the two-step Pay Entry Web flow rather than the
       * simpler form post, where the password travels through the browser.
       */
      return sendResponse(res, 200, 'Payment started', {
         status: 'REDIRECT',
         paymentUrl: init.paymentUrl,
         reference: order.reference,
      })
   }
)

/* ----------------------------- ALL /payments/maxicash/notify/:token (hook) */

/**
 * A body no parser took. MaxiCash does not say how it posts its notice, and
 * this API only parses JSON and forms that announce themselves as such — so
 * whatever else arrives is read here: capped, and never a throw.
 */
const unparsedBody = (req: Request) =>
   new Promise<string>((resolve) => {
      if (req.readableEnded || !req.readable) return resolve('')
      const chunks: Buffer[] = []
      let size = 0
      const done = () => resolve(Buffer.concat(chunks).toString('utf8'))
      req.on('data', (chunk: Buffer) => {
         size += chunk.length
         if (size <= 10_000) chunks.push(chunk)
      })
      req.on('end', done)
      req.on('error', done)
      setTimeout(done, 3000)
   })

/** …and taken for what it most likely is: JSON, or `a=b&c=d`. Anything else is kept as it came. */
const fieldsOf = (text: string): Record<string, any> | undefined => {
   const t = text.trim()
   if (!t) return undefined
   try {
      const json = JSON.parse(t)
      if (json && typeof json === 'object') return json
   } catch {
      /* not JSON */
   }
   return /^[^=&\s<]+=/.test(t) ? Object.fromEntries(new URLSearchParams(t)) : undefined
}

/**
 * MaxiCash telling this server what happened to a payment.
 *
 * The address is what makes it MaxiCash: it holds a token made for one
 * attempt on one order and sent, server to server, only to MaxiCash. Nothing
 * else about the call can be checked — MaxiCash signs nothing — so nothing
 * else is relied on, and what it says still has to agree with the order
 * before the order is marked paid.
 *
 * Always answers 200: anything else tells a prober which addresses exist, and
 * makes MaxiCash repeat a call that will never match.
 */
export const maxicashNotify = catchAsync(async (req: Request, res: Response) => {
   const received = () => res.status(200).json({ received: true })
   const token = req.params.token
   const body = await unparsedBody(req)
   const sentAs = String(req.headers['content-type'] ?? '-').slice(0, 80)
   const n = parseNotification([req.query as any, req.body, fieldsOf(body)])
   logRaw(`notify ${req.method} ${sentAs}`, JSON.stringify(n.params) + (body ? ` body=${body}` : ''))

   if (!isToken(token)) return received()
   const hash = tokenHash(token)
   const order = await Order.findOne({ 'payment.attempts.notifyHash': hash })
   if (!order) {
      console.warn('[maxicash] a notification on an address that belongs to no order — ignored')
      return received()
   }

   /**
    * What it says has to be about this order. The reference and the amount
    * were sent with this order's own figures to this one address, so a call
    * that names another reference, or an amount that does not cover this
    * order, is not this payment — it is left for the office, never settled.
    * (See `amountCovers`: cents or whole units, with or without MaxiCash's
    * own fee on top.)
    */
   const disagrees =
      (n.reference !== null && n.reference.toUpperCase() !== order.reference) ||
      !amountCovers(Number(order.chargedTotal ?? order.total), n.amount)
   const outcome: SettlementOutcome = n.outcome === 'PAID' && disagrees ? 'PENDING' : n.outcome

   console.log(
      `[maxicash] notify order=${order.reference} said=${n.claimedStatus ?? '-'} taken as ${outcome}` +
         (disagrees ? ` — it names reference ${n.reference ?? '-'} and amount ${n.amount ?? '-'}, not this order's` : '')
   )

   /**
    * "Did not pay" only counts from the attempt now open, as it does when the
    * customer comes back: a late notice about a page they have since left
    * must not fail the payment they are making on another. Money, or anything
    * unreadable, counts from any attempt.
    */
   const attempts = order.payment?.attempts ?? []
   if (outcome === 'FAILED' && attempts[attempts.length - 1]?.notifyHash !== hash) {
      return received()
   }

   // As it arrived, until its format is known for certain.
   const set: Record<string, unknown> = {
      'payment.lastNotification': {
         at: new Date(),
         method: req.method,
         sentAs,
         params: n.params,
         ...(body ? { body: body.slice(0, 2000) } : {}),
      },
   }
   if (n.paymentId) set['payment.providerPaymentId'] = n.paymentId
   if (n.method) set['payment.providerMethod'] = n.method.slice(0, 40)
   await Order.updateOne({ _id: order._id }, { $set: set })

   /**
    * A notice that cannot be read as "paid" or "failed", or that does not
    * agree with the order: before leaving it for the office, ask MaxiCash
    * itself about this reference. If it says paid, it is paid.
    */
   if (outcome === 'PENDING' && (await askMaxicash(order))) return received()

   const said = String(n.claimedStatus ?? 'UNKNOWN').toUpperCase().slice(0, 40)
   await settle(order._id, outcome, disagrees ? `${said} (does not match the order)` : said)
   return received()
})

/* ------------------------------------------- POST /payments/maxicash/return */

/**
 * The customer's browser, back from MaxiCash's page.
 *
 * It arrives on an address the customer can see, so it settles nothing. It
 * does three smaller things: says which booking this is (the page that calls
 * it knows only the token), records that the customer came back and what
 * MaxiCash added to the address, and — on the address MaxiCash uses after a
 * payment — keeps the booking alive until MaxiCash's own word arrives, where
 * the office can see it waiting.
 */
export const maxicashReturn = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const token = req.body?.token
      if (!isToken(token)) return next(new AppError('Payment not found', 404))
      const hash = tokenHash(token)
      const order = await Order.findOne({
         $or: [
            { 'payment.attempts.successHash': hash },
            { 'payment.attempts.failureHash': hash },
         ],
      })
      if (!order) return next(new AppError('Payment not found', 404))

      const attempts = order.payment?.attempts ?? []
      const success = attempts.some((a) => a.successHash === hash)
      // "Did not pay" only counts from the attempt now open: an old tab giving
      // up must not fail a payment the customer is making in another.
      const latest = attempts[attempts.length - 1]?.failureHash === hash
      const n = parseNotification([req.body?.params])
      logRaw(`return ${success ? 'success' : 'failure'}`, JSON.stringify(n.params))

      const settings = await getSettings()
      await again(async () => {
         const fresh = await Order.findById(order._id)
         if (
            !fresh ||
            fresh.paymentStatus === PAYMENT_STATUS.PAID ||
            fresh.status === ORDER_STATUS.CANCELLED
         ) {
            return
         }
         if (success) {
            const first = fresh.payment?.returnOutcome !== 'SUCCESS'
            fresh.set('payment.returnedAt', new Date())
            fresh.set('payment.returnOutcome', 'SUCCESS')
            fresh.set('payment.lastReturn', { at: new Date(), params: n.params })
            // Not released on the short online hold while MaxiCash's word is
            // still on its way: it waits as long as a cash booking would.
            const until = new Date(Date.now() + settings.holdTtlCashHours * 3600_000)
            if (!fresh.cashDeadline || fresh.cashDeadline < until) fresh.cashDeadline = until
            if (first) {
               fresh.timeline.push({
                  event: 'PAYMENT_RETURNED',
                  detail: 'The customer came back from MaxiCash by the address it uses after a payment; waiting for MaxiCash to confirm',
               })
            }
         } else if (latest && fresh.paymentMethod === PAYMENT_METHOD.ONLINE) {
            fresh.set('payment.returnedAt', new Date())
            fresh.set('payment.returnOutcome', 'FAILURE')
            fresh.set('payment.lastReturn', { at: new Date(), params: n.params })
            if (fresh.paymentStatus !== PAYMENT_STATUS.FAILED) {
               fresh.paymentStatus = PAYMENT_STATUS.FAILED
               fresh.timeline.push({
                  event: 'PAYMENT_FAILED',
                  detail: 'The customer came back from MaxiCash without paying',
               })
            }
         } else {
            return
         }
         await fresh.save()
      })

      /**
       * Back by the address MaxiCash uses after a payment. Its notice may be
       * late, lost or unreadable — so ask it now, and the customer who has
       * paid is shown so at once instead of "being confirmed". (Also for a
       * booking that lapsed meanwhile: money for it must not go unseen.)
       */
      if (success) {
         const fresh = await Order.findById(order._id)
         if (fresh) await askMaxicash(fresh)
      }

      const now = await Order.findById(order._id).select('paymentStatus status')
      return sendResponse(res, 200, 'OK', {
         reference: order.reference,
         outcome: success ? 'SUCCESS' : 'FAILURE',
         paymentStatus: now?.paymentStatus ?? order.paymentStatus,
         paid: now?.paymentStatus === PAYMENT_STATUS.PAID,
         cancelled: now?.status === ORDER_STATUS.CANCELLED,
      })
   }
)

/* --------------------------------- GET /orders/:reference/payment (polling) */

/**
 * A screen is waiting on a payment that may already have been made: have
 * MaxiCash asked, in the background, so that a later look finds the answer.
 * Not awaited — reading an order must not wait on MaxiCash — and paced by
 * `askMaxicash` itself, however often screens poll.
 */
export const nudge = (order: Parameters<typeof askMaxicash>[0] & Parameters<typeof paymentAwaited>[0]) => {
   if (paymentAwaited(order)) void askMaxicash(order)
}

/**
 * What the customer's screen polls for the order's payment state: the order's
 * own, which only `settle()` (MaxiCash) and the office can move to paid.
 */
export const paymentStatus = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const reference = String(req.params.reference).toUpperCase()
      const order = await Order.findOne({ reference })
      if (!order) return next(new AppError('Order not found', 404))
      nudge(order)

      return sendResponse(res, 200, 'OK', {
         reference,
         paymentStatus: order.paymentStatus,
         paid: order.paymentStatus === PAYMENT_STATUS.PAID,
      })
   }
)
