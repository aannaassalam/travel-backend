import crypto from 'crypto'

import { CURRENCIES, Currency } from '../../constants/domain.constants'
import AppError from '../../utils/appError'

/**
 * MaxiCash — the online payment provider.
 *
 * Built to MaxiCash's own integration guide (developer.maxicashapp.com), and
 * to nothing else: every field sent and every address called is one that
 * guide documents. Of the three ways it gives to reach its Gateway, this is
 * the one it calls "Pay Entry Web":
 *
 *   step 1   POST {webapi}/Integration/PayEntryWeb          -> { LogID }
 *   step 2   send the customer to {gateway}/payentryweb?logid=<LogID>
 *
 * The other two ("Form Post" and "QueryString") put `MerchantPassword` in a
 * page or an address the customer's browser holds, which hands the merchant's
 * credential to anyone who opens dev tools. Here the password never leaves
 * this server and the customer only ever sees an opaque LogID.
 *
 * On MaxiCash's page the customer chooses how to pay — card, mobile money, a
 * MaxiCash wallet. The guide gives no way to choose for them (`PayType` is
 * "always to be set to MaxiCash"), so this site offers one online option and
 * does not pretend to pick the channel.
 *
 * ---------------------------------------------------------------------------
 * How a payment is known to have happened
 * ---------------------------------------------------------------------------
 * The guide gives the Gateway one way to tell a merchant: it calls `NotifyURL`
 * "to notify the merchant website of the status of the transaction" and then
 * sends the customer to `SuccessURL`, `FailureURL` or `CancelURL`, adding "a
 * few query string parameters" to each. It signs none of them, and it never
 * says what those parameters are.
 *
 * So the proof that a call came from MaxiCash has to be the address itself.
 * Every attempt gets addresses of its own, each carrying 256 random bits:
 *
 *   NotifyURL   sent to MaxiCash server to server, in step 1, and to nobody
 *               else. A call on it is MaxiCash speaking — or someone MaxiCash
 *               told. It is the only thing that can mark an order paid.
 *   SuccessURL  where the customer's browser lands after paying. The customer
 *               sees it, so it proves nothing by itself: it is recorded, shown
 *               to the office, and keeps the booking from being auto-cancelled
 *               while the notification is still on its way.
 *   Failure/CancelURL  another token again, so that seeing this one does not
 *               give away the success address.
 *
 * Only their SHA-256 is stored: a copy of the database, an audit entry or a
 * log line cannot be turned back into an address that confirms a payment.
 *
 * `MAXICASH_LOG_RAW=true` logs what MaxiCash actually sends, for the first
 * payment on a new account — the one way to see the parameters it never
 * documented.
 *
 * ---------------------------------------------------------------------------
 * What MaxiCash publishes beside the guide
 * ---------------------------------------------------------------------------
 * The server behind step 1 documents itself (webapi-test.maxicashapp.com/Help,
 * generated from its code). Three things are taken from there, and from the
 * Gateway's own service description (…/Merchant/api.asmx):
 *
 *   - `PayEntryWeb` also takes `Email` (and names, which its page ignores):
 *     the e-mail arrives filled in on MaxiCash's form, one field fewer for
 *     the customer to type. Checked on the sandbox.
 *   - `Integration/CheckPaymentStatusByReference` answers, to the merchant's
 *     own credentials, whether a reference has been paid. See
 *     `checkPaymentStatus`.
 *   - The operation MaxiCash notifies merchants with carries `Reference`,
 *     `Status`, `Method`, `MaxiCashTransactionID`, `Amount` and `Fee` — the
 *     names `parseNotification` reads.
 *
 * Seen for real on the sandbox (2026-10-15, a declined mobile-money payment):
 * MaxiCash shows its own "Paiement échoué" page for a few seconds, then sends
 * the browser to the merchant's FailureURL with
 * `?status=failed&reference=<Reference>&Method=MobileMoney` appended. No
 * NotifyURL call accompanied that failure. A SUCCESSFUL payment has still not
 * been seen: the sandbox's card path fails inside MaxiCash's own server.
 */

/* ------------------------------------------------------------------ config */

/**
 * As the guide lists them. (The same servers also answer to older
 * `…maxicashme.com` names, which MaxiCash still quotes in some letters; their
 * certificate lapsed in September 2026, so a call to them fails. Use these.)
 */
const ENVIRONMENTS = {
   sandbox: {
      /** JSON API: step 1. */
      api: 'https://webapi-test.maxicashapp.com',
      /** Where the customer is sent: step 2. */
      gateway: 'https://api-testbed.maxicashapp.com',
   },
   live: {
      api: 'https://webapi.maxicashapp.com',
      gateway: 'https://api.maxicashapp.com',
   },
} as const

export interface MaxicashConfig {
   merchantId: string
   merchantPassword: string
   apiUrl: string
   gatewayUrl: string
   /** This API's own public address: MaxiCash must be able to reach it. */
   publicUrl: string
   /** The website, where the customer comes back to. */
   siteUrl: string
}

const isPublicAddress = (url: string) =>
   /^https:\/\/(?!localhost\b|127\.|10\.|192\.168\.)/.test(url)

/**
 * Read at first use, never logged.
 *
 * Throws rather than falling back to a stub: a checkout that silently "works"
 * without a provider configured is how an order gets marked paid for money
 * nobody collected.
 */
export const maxicashConfig = (): MaxicashConfig => {
   const merchantId = process.env.MAXICASH_MERCHANT_ID
   const merchantPassword = process.env.MAXICASH_MERCHANT_PASSWORD
   const publicUrl = (process.env.API_PUBLIC_URL || '').replace(/\/$/, '')
   // The website's address, as the links in SMS and e-mail already read it.
   const siteUrl = (process.env.PUBLIC_SITE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '')
   const env = process.env.MAXICASH_ENV === 'live' ? 'live' : 'sandbox'

   if (!merchantId || !merchantPassword || !publicUrl || !siteUrl) {
      throw new AppError('Online payment is not configured', 503, 'PAYMENT_UNAVAILABLE')
   }
   /**
    * Real money needs real addresses: MaxiCash has to reach this API to say a
    * payment went through, and the customer's browser has to get back to the
    * website. A live account pointed at a developer's machine would take the
    * money and confirm nothing — so with these wrong, online payment is not
    * offered at all. (`paymentsStatus` says so in the start-up log.)
    */
   if (env === 'live' && !(isPublicAddress(publicUrl) && isPublicAddress(siteUrl))) {
      throw new AppError('Online payment is not configured', 503, 'PAYMENT_UNAVAILABLE')
   }

   const hosts = ENVIRONMENTS[env]
   return {
      merchantId,
      merchantPassword,
      apiUrl: process.env.MAXICASH_API_URL?.replace(/\/$/, '') || hosts.api,
      gatewayUrl: process.env.MAXICASH_GATEWAY_URL?.replace(/\/$/, '') || hosts.gateway,
      publicUrl,
      siteUrl,
   }
}

/**
 * A payment that may already have been made, and is not confirmed: the
 * customer came back from MaxiCash by the address it uses after a payment, or
 * MaxiCash has told this server something about it that could not be read as
 * "paid" or "failed". Either way it is not the moment to open another payment
 * — that is how someone pays twice — and the office should look.
 */
export const paymentAwaited = (order: {
   paymentStatus?: string
   payment?: { returnOutcome?: string; lastNotification?: unknown } | null
}): boolean =>
   order.paymentStatus === 'PENDING' &&
   (order.payment?.returnOutcome === 'SUCCESS' || Boolean(order.payment?.lastNotification))

/** True when the provider is configured, without throwing. For capability checks. */
export const maxicashEnabled = (): boolean => {
   try {
      maxicashConfig()
      return true
   } catch {
      return false
   }
}

/**
 * One line for the start-up log: whether online payment is offered and, where
 * it is not, which setting is the reason. Names and public addresses only —
 * never a credential.
 */
export const paymentsStatus = (): string => {
   if (process.env.ONLINE_PAYMENTS_ENABLED !== 'true') {
      return 'Online payment: OFF, cash only (ONLINE_PAYMENTS_ENABLED is not "true")'
   }
   const set = (name: string) => Boolean(process.env[name])
   const missing = ['MAXICASH_MERCHANT_ID', 'MAXICASH_MERCHANT_PASSWORD', 'API_PUBLIC_URL']
      .filter((name) => !set(name))
      .concat(set('PUBLIC_SITE_URL') || set('FRONTEND_URL') ? [] : ['FRONTEND_URL'])
   if (missing.length) {
      return `Online payment: NOT OFFERED, cash only (switched on, but not set: ${missing.join(', ')})`
   }
   if (!maxicashEnabled()) {
      return 'Online payment: NOT OFFERED, cash only (MAXICASH_ENV is "live", but API_PUBLIC_URL and FRONTEND_URL must both be public https addresses)'
   }
   const cfg = maxicashConfig()
   const live = process.env.MAXICASH_ENV === 'live'
   return (
      `Online payment: ON through MaxiCash ${live ? 'LIVE (real money)' : 'sandbox (test money)'}; ` +
      `MaxiCash confirms on ${cfg.publicUrl} and customers come back to ${cfg.siteUrl}`
   )
}

/* ------------------------------------------------------------------- money */

/**
 * Our currency -> MaxiCash's. Its platform has two, the maxiDollar ("a 1 to 1
 * exchange rate to the American USD") and the maxiRand; Pay Entry Web takes
 * one of those two names.
 *
 * Deliberately NOT including CDF or EUR: the catalogue prices in both, and an
 * order in either must be refused here rather than silently charged as dollars.
 */
const PROVIDER_CURRENCIES: Record<string, string> = { USD: 'maxiDollar' }

/** The currencies an order can be paid online in. */
export const onlineCurrencies = Object.keys(PROVIDER_CURRENCIES)

/**
 * The least MaxiCash will take, in our minor units (USD 5.00). Its page turns
 * a smaller payment away — "The transaction amount cannot be lower than 5
 * Dollars" — after step 1 has already said "success", and leaves the customer
 * on a page of its own. So it is refused here first, in words the screens
 * translate.
 */
export const onlineMinimumMinor = 500

export const belowOnlineMinimum = () =>
   new AppError('This amount is too small to pay online', 400, 'AMOUNT_BELOW_MINIMUM', {
      minimum: onlineMinimumMinor,
   })

/**
 * Our stored minor units -> the amount MaxiCash expects.
 *
 * MaxiCash takes CENTS — "if you would like to process a payment of 1 USD, you
 * must send an amount of 100" — which is exactly how money is stored here, so
 * for USD this is the identity function and there is no rounding anywhere.
 *
 * The guard still exists because the identity only holds where our minor-unit
 * exponent is 2. CDF is stored with no decimals, so its "minor units" are whole
 * francs and passing them as cents would undercharge by 100x — hence the
 * currency allow-list above rather than a silent conversion.
 */
export const toProviderAmount = (minor: number, currency: Currency): number => {
   if (!Number.isInteger(minor) || minor <= 0) {
      throw new AppError('Invalid payment amount', 400, 'AMOUNT_INVALID')
   }
   if (!PROVIDER_CURRENCIES[currency]) {
      throw new AppError(
         `${currency} cannot be paid online`,
         400,
         'CURRENCY_UNSUPPORTED',
         { provider: 'MAXICASH', currency, supported: onlineCurrencies }
      )
   }
   if (minor < onlineMinimumMinor) throw belowOnlineMinimum()
   return minor
}

/* ---------------------------------------------------------------- secrets */

/** One address's worth of proof: 256 random bits, as 64 hex characters. */
export const newToken = () => crypto.randomBytes(32).toString('hex')

/** What is stored of a token. See the note at the top of this file. */
export const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

/** A token as this server writes them — anything else is not looked up at all. */
export const isToken = (value: unknown): value is string =>
   typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/* -------------------------------------------------------------------- http */

/**
 * Full response body, for commissioning the integration.
 *
 * Off by default and log-only: the request carries `MerchantPassword`, which
 * belongs in neither a response nor a log that gets shipped somewhere.
 */
export const logRaw = (what: string, body: string) => {
   if (process.env.MAXICASH_LOG_RAW !== 'true') return
   console.error(`[maxicash:raw] ${what} ${body.slice(0, 2000)}`)
}

const postJson = async (url: string, body: unknown, timeoutMs = 20_000): Promise<any> => {
   const controller = new AbortController()
   const timer = setTimeout(() => controller.abort(), timeoutMs)
   try {
      const res = await fetch(url, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
         body: JSON.stringify(body),
         signal: controller.signal,
      })
      const text = await res.text()
      logRaw(url, text)
      let json: any = {}
      try {
         json = text ? JSON.parse(text) : {}
      } catch {
         /* non-JSON; the status check below decides what that means */
      }
      if (!res.ok) {
         const detail = {
            provider: 'MAXICASH',
            endpoint: url,
            httpStatus: res.status,
            responseStatus: json?.ResponseStatus ?? null,
            description: json?.ResponseError ?? json?.ResponseData ?? text.slice(0, 300),
         }
         console.error(`[maxicash] ${JSON.stringify(detail)}`)
         // The detail is for the server's log: what MaxiCash says in refusing
         // may name the merchant account, and is nothing a customer can use.
         throw new AppError('The payment provider refused the request', 502, 'PROVIDER_ERROR')
      }
      return json
   } catch (err) {
      if (err instanceof AppError) throw err
      const detail = {
         provider: 'MAXICASH',
         endpoint: url,
         reason: (err as Error).name === 'AbortError' ? `timeout after ${timeoutMs / 1000}s` : (err as Error).message,
      }
      console.error(`[maxicash] ${JSON.stringify(detail)}`)
      throw new AppError('The payment provider is unreachable', 502, 'PROVIDER_UNREACHABLE')
   } finally {
      clearTimeout(timer)
   }
}

/* --------------------------------------------------------------- the call */

export interface InitInput {
   /** Our order reference. Becomes MaxiCash's `Reference`. */
   reference: string
   /** Minor units, read off the order — never from the request body. */
   amountMinor: number
   currency: Currency
   phone?: string
   /** Arrives filled in on MaxiCash's page, which asks every payer for one. */
   email?: string
   locale?: string
   /** This attempt's own three addresses' tokens (see the top of this file). */
   tokens: { notify: string; success: string; failure: string }
}

export interface InitResult {
   /** MaxiCash's LogID. The only thing the customer's browser ever sees. */
   logId: string
   paymentUrl: string
   raw: unknown
}

/**
 * Opens a transaction and returns the URL to send the customer to.
 *
 * Step 1 of Pay Entry Web. The body is the guide's sample, field for field,
 * plus the payer's e-mail where known — a field the endpoint's own reference
 * lists. No other `PayType`: the guide says "always MaxiCash".
 */
export const initializePayment = async (input: InitInput): Promise<InitResult> => {
   const cfg = maxicashConfig()

   if (!CURRENCIES.includes(input.currency)) {
      throw new AppError('Unsupported payment currency', 400, 'CURRENCY_UNSUPPORTED')
   }
   const amount = toProviderAmount(input.amountMinor, input.currency)
   // The token is the last thing in the path, and the address has no query
   // string of its own: MaxiCash adds parameters to these, and how it joins
   // them to an address that already has some is not written down.
   const back = (token: string) => `${cfg.siteUrl}/booking/payment/return/${token}`

   const data = await postJson(`${cfg.apiUrl}/Integration/PayEntryWeb`, {
      PayType: 'MaxiCash',
      MerchantID: cfg.merchantId,
      MerchantPassword: cfg.merchantPassword,
      // Cents, as a string — the documented sample sends "1000", not 1000.
      Amount: String(amount),
      Currency: PROVIDER_CURRENCIES[input.currency],
      Telephone: input.phone ?? '',
      Language: input.locale?.toLowerCase().startsWith('en') ? 'en' : 'fr',
      Reference: input.reference,
      SuccessURL: back(input.tokens.success),
      FailureURL: back(input.tokens.failure),
      CancelURL: back(input.tokens.failure),
      NotifyURL: `${cfg.publicUrl}/api/v1/payments/maxicash/notify/${input.tokens.notify}`,
      ...(input.email ? { Email: input.email } : {}),
   })

   const logId = data?.LogID ?? data?.ResponseData
   const ok = String(data?.ResponseStatus ?? '').toLowerCase() === 'success'

   if (!ok || !logId) {
      const detail = {
         provider: 'MAXICASH',
         endpoint: 'POST /Integration/PayEntryWeb',
         responseStatus: data?.ResponseStatus ?? null,
         description: data?.ResponseError ?? data?.ResponseData ?? null,
         amount,
         currency: input.currency,
         missing: !logId ? 'LogID' : undefined,
      }
      console.error(`[maxicash] ${JSON.stringify(detail)}`)
      throw new AppError('The payment provider refused the request', 502, 'PROVIDER_ERROR')
   }

   return {
      logId: String(logId),
      paymentUrl: `${cfg.gatewayUrl}/payentryweb?logid=${encodeURIComponent(String(logId))}`,
      raw: data,
   }
}

/**
 * Does the amount MaxiCash reports cover this order?
 *
 * MaxiCash is told cents and may answer in cents or in whole units. And its
 * payment page adds its own processing fee on top of what the merchant asked
 * for — on the sandbox 3.5%, and never less than a dollar (915.00 is charged
 * 947.02; 23.45 is charged 24.45) — so what it reports may be the order's
 * amount or that amount plus the fee. Anything from the order's amount up to
 * 15% (or, on a small order, a dollar and a half) more is this payment; less
 * than the order's amount, or far more, is not. An amount it does not send is
 * nothing to disagree with.
 */
export const amountCovers = (expectedMinor: number, reported: string | null): boolean => {
   if (reported === null) return true
   const n = Number(reported)
   if (!Number.isFinite(n) || n <= 0) return false
   const within = (cents: number) =>
      cents >= expectedMinor && cents <= expectedMinor + Math.max(expectedMinor * 0.15, 150)
   return within(n) || within(Math.round(n * 100))
}

/* ------------------------------------------------------- asking MaxiCash */

export interface PaymentStatusAnswer {
   /** MaxiCash says this reference has been paid. */
   paid: boolean
   /** Its word for the transaction's state, as it came. */
   status: string | null
   /** Its own number for the payment, when it gives one. */
   transactionId: string | null
}

/**
 * Asks MaxiCash, with the merchant's own credentials, what has happened to a
 * reference: `Integration/CheckPaymentStatusByReference`, on the same server
 * as step 1.
 *
 *   -> { MerchantID, MerchantPassword, Reference, TransactionID }
 *   <- { ResponseStatus: "success", ResponseDesc: "TransactionStatus",
 *        ResponseData: "<the status>", TransactionID, Reference }
 *
 * `ResponseStatus` says the question was answered; the transaction's own
 * state is `ResponseData`. The sandbox answers "failed" for a payment that
 * failed, for one not made yet AND for a reference it has never seen — so
 * only "paid" means anything here, and nothing but a success word, about the
 * very reference asked, is taken as paid.
 *
 * Throws like every call to MaxiCash when it cannot be reached; callers that
 * are only double-checking treat that as "do not know".
 */
export const checkPaymentStatus = async (reference: string): Promise<PaymentStatusAnswer> => {
   const cfg = maxicashConfig()
   const data = await postJson(
      `${cfg.apiUrl}/Integration/CheckPaymentStatusByReference`,
      {
         MerchantID: cfg.merchantId,
         MerchantPassword: cfg.merchantPassword,
         Reference: reference,
         TransactionID: '',
      },
      // A customer may be waiting on this answer: not the 20 seconds a payment's opening gets.
      8_000
   )
   const answered = String(data?.ResponseStatus ?? '').toLowerCase() === 'success'
   const status = typeof data?.ResponseData === 'string' ? data.ResponseData.slice(0, 40) : null
   const about = typeof data?.Reference === 'string' ? data.Reference : null
   const paid =
      answered &&
      SUCCESS_WORDS.has(String(status ?? '').trim().toLowerCase()) &&
      (about === null || about.toUpperCase() === reference.toUpperCase())
   const id = data?.TransactionID
   return {
      paid,
      status,
      transactionId: typeof id === 'string' || typeof id === 'number' ? String(id).slice(0, 60) : null,
   }
}

/* ------------------------------------------------------------ what it says */

export type SettlementOutcome = 'PAID' | 'FAILED' | 'PENDING'

/** Words that mean the money has been taken. */
const SUCCESS_WORDS = new Set(['success', 'successful', 'succeeded', 'completed', 'paid', 'approved'])
/** Words that mean it will not be. Anything else is still in flight. */
const FAILURE_WORDS = new Set([
   'failed',
   'failure',
   'declined',
   'cancelled',
   'canceled',
   'expired',
   'rejected',
   'error',
])

export interface Notification {
   /** What the parameters say happened; PENDING when they do not say. */
   outcome: SettlementOutcome
   /** The status word as it arrived, for the office and the log. */
   claimedStatus: string | null
   /** Our order reference, if MaxiCash sends it back. */
   reference: string | null
   /** MaxiCash's own number for the payment, if it sends one: what the office looks it up by. */
   paymentId: string | null
   /** How it was paid, in MaxiCash's words (a card, an operator), if it says. */
   method: string | null
   /** The amount, if it is sent, as written. */
   amount: string | null
   /** Everything that arrived, trimmed — kept with the order until the format is known for certain. */
   params: Record<string, string>
}

/**
 * Reads what MaxiCash added to an address it called.
 *
 * The guide promises "a few query string parameters" and lists none, and its
 * Gateway is an ASP.NET application that could send them in the address or in
 * a posted form. So both are read, names are matched whatever their case, and
 * a status word this does not recognise is PENDING — never paid.
 */
export const parseNotification = (sources: Array<Record<string, any> | undefined>): Notification => {
   const flat: Record<string, string> = {}
   for (const src of sources) {
      if (!src || typeof src !== 'object') continue
      for (const [k, v] of Object.entries(src)) {
         if (v === undefined || v === null || typeof v === 'object') continue
         if (Object.keys(flat).length >= 30) break
         flat[String(k).toLowerCase().slice(0, 60)] = String(v).slice(0, 300)
      }
   }
   const pick = (...names: string[]) => {
      for (const n of names) if (flat[n]) return flat[n]
      return null
   }
   const claimedStatus = pick('status', 'responsestatus', 'paymentstatus', 'transactionstatus', 'result')
   const word = String(claimedStatus ?? '').trim().toLowerCase()
   return {
      outcome: SUCCESS_WORDS.has(word) ? 'PAID' : FAILURE_WORDS.has(word) ? 'FAILED' : 'PENDING',
      claimedStatus,
      reference: pick('reference', 'merchantreference', 'orderid'),
      paymentId: pick('maxicashtransactionid', 'pmtid', 'paymentid', 'transactionid', 'transid'),
      method: pick('method', 'paymethod', 'paymentmethod'),
      amount: pick('amount', 'paymentamount', 'transactionamount'),
      params: flat,
   }
}
