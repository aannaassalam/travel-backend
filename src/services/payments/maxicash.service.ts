import { CURRENCIES, Currency } from '../../constants/domain.constants'
import AppError from '../../utils/appError'

/**
 * MaxiCash — the online payment provider.
 *
 * Replaces CinetPay, which on this merchant's account could only ever offer
 * three DRC mobile-money wallets: no card, no bank transfer, USD only, a USD 100
 * floor, and whole-dollar amounts only — which together made roughly a third of
 * the catalogue unsellable online.
 *
 * Two hosts, and they are NOT interchangeable:
 *
 *   api      POST {webapi}/Integration/PayEntryWeb   -> { LogID }
 *   redirect GET  {gateway}/payentryweb?logid=<LogID>
 *   status   POST {gateway}/Merchant/api.asmx/PayNowStatus
 *
 * The two-step "Pay Entry Web" flow is deliberately the one used, rather than
 * the simpler `PayEntryPost` form or the `PayEntry` query string. Both of those
 * require `MerchantPassword` to travel through the customer's browser, which
 * hands the merchant credential to anyone who opens dev tools. Here the
 * password never leaves this server and the customer only ever sees an opaque
 * LogID.
 *
 * ---------------------------------------------------------------------------
 * The rule this file exists to enforce, unchanged from the previous provider
 * ---------------------------------------------------------------------------
 * NOTHING a client sends can mark an order paid. The notification is a hint
 * that something changed; the truth is a server-to-server status check. See
 * `fetchPaymentStatus`, and read the warning above it — MaxiCash's notification
 * format is not published, so this integration fails CLOSED where the previous
 * one could fail open.
 */

/* ------------------------------------------------------------------ config */

const ENVIRONMENTS = {
   sandbox: {
      /** JSON API: initialisation. */
      api: 'https://webapi-test.maxicashapp.com',
      /** Where the customer is sent, and where status lives. */
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
   /** Server-to-server notification. Must be publicly reachable. */
   notifyUrl: string
   successUrl: string
   failureUrl: string
   cancelUrl: string
}

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
   const siteUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '')
   const env = process.env.MAXICASH_ENV === 'live' ? 'live' : 'sandbox'

   if (!merchantId || !merchantPassword || !publicUrl || !siteUrl) {
      throw new AppError('Online payment is not configured', 503, 'PAYMENT_UNAVAILABLE')
   }

   const hosts = ENVIRONMENTS[env]
   const ret = `${siteUrl}/booking/payment/return`
   return {
      merchantId,
      merchantPassword,
      apiUrl: process.env.MAXICASH_API_URL?.replace(/\/$/, '') || hosts.api,
      gatewayUrl: process.env.MAXICASH_GATEWAY_URL?.replace(/\/$/, '') || hosts.gateway,
      notifyUrl: `${publicUrl}/api/v1/payments/maxicash/notify`,
      /**
       * One return page for all three outcomes. It proves nothing by itself —
       * it asks our server, which asks MaxiCash — so there is no benefit in
       * three separate pages and a real cost: a customer who cancels and one
       * who fails must not be told anything the provider has not confirmed.
       */
      successUrl: ret,
      failureUrl: ret,
      cancelUrl: ret,
   }
}

/** True when the provider is configured, without throwing. For capability checks. */
export const maxicashEnabled = (): boolean => {
   try {
      maxicashConfig()
      return true
   } catch {
      return false
   }
}

/* ------------------------------------------------------------------- money */

/**
 * Currencies MaxiCash settles. `maxiDollar` and `maxiRand` are its internal
 * wallet units and are not something we price in, so the practical list is USD.
 *
 * Deliberately NOT including CDF or EUR: the catalogue prices in both, and an
 * order in either must be refused here rather than silently charged as dollars.
 */
const PROVIDER_CURRENCIES: Record<string, string> = { USD: 'USD' }

/**
 * Our stored minor units -> the amount MaxiCash expects.
 *
 * MaxiCash takes CENTS — "if you would like to process a payment of 1 USD, you
 * must send an amount of 100" — which is exactly how money is stored here, so
 * for USD this is the identity function and there is no rounding anywhere.
 *
 * That is the single biggest correctness win of the move: the previous provider
 * wanted whole dollars, so a $176.13 booking could not be charged at all.
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
         { provider: 'MAXICASH', currency, supported: Object.keys(PROVIDER_CURRENCIES) }
      )
   }
   return minor
}

/* ------------------------------------------------------------------- rails */

/**
 * Our PaymentRail -> MaxiCash `PayType`.
 *
 * All four are first-class here, which is the reason for the move: the previous
 * provider could offer only mobile money on this account.
 */
const PAY_TYPES: Record<string, string> = {
   CARD: 'VISA',
   MOBILE_MONEY: 'MobileMoney',
   WALLET: 'MaxiCash',
   BANK_TRANSFER: 'BankTransfer',
}

/** Rails MaxiCash can settle. Anything else is collected by the office. */
export const providerRails = Object.keys(PAY_TYPES)

/* -------------------------------------------------------------------- http */

/**
 * Full response body, for commissioning the integration.
 *
 * Off by default and log-only: the request carries `MerchantPassword`, which
 * belongs in neither a response nor a log that gets shipped somewhere.
 */
const logRaw = (endpoint: string, body: string) => {
   if (process.env.MAXICASH_LOG_RAW !== 'true') return
   console.error(`[maxicash:raw] ${endpoint} ${body.slice(0, 2000)}`)
}

const postJson = async (url: string, body: unknown): Promise<any> => {
   const controller = new AbortController()
   const timer = setTimeout(() => controller.abort(), 20_000)
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
         throw new AppError(
            'The payment provider refused the request',
            502,
            'PROVIDER_ERROR',
            detail
         )
      }
      return json
   } catch (err) {
      if (err instanceof AppError) throw err
      const detail = {
         provider: 'MAXICASH',
         endpoint: url,
         reason: (err as Error).name === 'AbortError' ? 'timeout after 20s' : (err as Error).message,
      }
      console.error(`[maxicash] ${JSON.stringify(detail)}`)
      throw new AppError('The payment provider is unreachable', 502, 'PROVIDER_UNREACHABLE', detail)
   } finally {
      clearTimeout(timer)
   }
}

/* --------------------------------------------------------------- the calls */

export interface InitInput {
   /** Our order reference. Becomes MaxiCash's `Reference`. */
   merchantTransactionId: string
   /** Minor units, read off the order — never from the request body. */
   amountMinor: number
   currency: Currency
   firstName: string
   lastName: string
   email: string
   phone?: string
   locale?: string
   /** Our PaymentRail; selects the MaxiCash PayType. */
   rail?: string
}

export interface InitResult {
   /** MaxiCash's LogID. The only thing the customer's browser ever sees. */
   logId: string
   paymentUrl: string
   payType: string
   raw: unknown
}

/**
 * Opens a transaction and returns the URL to send the customer to.
 *
 * Step 1 of MaxiCash's two-step web flow. The credentials go in this
 * server-to-server call; the customer gets only `?logid=<opaque>`.
 */
export const initializePayment = async (input: InitInput): Promise<InitResult> => {
   const cfg = maxicashConfig()

   if (!CURRENCIES.includes(input.currency)) {
      throw new AppError('Unsupported payment currency', 400, 'CURRENCY_UNSUPPORTED')
   }
   const amount = toProviderAmount(input.amountMinor, input.currency)
   const payType = PAY_TYPES[String(input.rail)] ?? PAY_TYPES.MOBILE_MONEY

   const data = await postJson(`${cfg.apiUrl}/Integration/PayEntryWeb`, {
      PayType: payType,
      MerchantID: cfg.merchantId,
      MerchantPassword: cfg.merchantPassword,
      // Cents, as a string — the documented sample sends "1000", not 1000.
      Amount: String(amount),
      Currency: PROVIDER_CURRENCIES[input.currency],
      Telephone: input.phone ?? '',
      Email: input.email,
      Language: input.locale?.toLowerCase().startsWith('en') ? 'en' : 'fr',
      Reference: input.merchantTransactionId,
      SuccessURL: cfg.successUrl,
      FailureURL: cfg.failureUrl,
      CancelURL: cfg.cancelUrl,
      NotifyURL: cfg.notifyUrl,
   })

   const logId = data?.LogID ?? data?.ResponseData ?? data?.logID
   const ok = String(data?.ResponseStatus ?? '').toLowerCase() === 'success'

   if (!ok || !logId) {
      const detail = {
         provider: 'MAXICASH',
         endpoint: 'POST /Integration/PayEntryWeb',
         responseStatus: data?.ResponseStatus ?? null,
         description: data?.ResponseError ?? data?.ResponseData ?? null,
         payType,
         amount,
         currency: input.currency,
         missing: !logId ? 'LogID' : undefined,
      }
      console.error(`[maxicash] ${JSON.stringify(detail)}`)
      throw new AppError('The payment provider refused the request', 502, 'PROVIDER_ERROR', detail)
   }

   return {
      logId: String(logId),
      paymentUrl: `${cfg.gatewayUrl}/payentryweb?logid=${encodeURIComponent(String(logId))}`,
      payType,
      raw: data,
   }
}

/* ------------------------------------------------------------ settlement */

/** Provider statuses that mean money has actually been captured. */
const SUCCESS_STATUSES = new Set(['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'PAID', 'ACCEPTED'])
/** Terminal failures. Anything else is still in flight and must stay pending. */
const FAILURE_STATUSES = new Set([
   'FAILED',
   'FAILURE',
   'DECLINED',
   'CANCELLED',
   'CANCELED',
   'EXPIRED',
   'REVERSED',
   'REJECTED',
])

export type SettlementOutcome = 'PAID' | 'FAILED' | 'PENDING'

export interface StatusResult {
   outcome: SettlementOutcome
   providerStatus: string
   /** The merchant reference MaxiCash says this payment was for, if it says. */
   reference: string | null
   raw: unknown
}

/**
 * Ask MaxiCash what actually happened.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING ANYTHING HERE
 * ---------------------------------------------------------------------------
 * MaxiCash publishes no signature, hash or shared secret on its notification,
 * and no endpoint that looks a transaction up by OUR reference. `PayNowStatus`
 * needs `PmtID` — MaxiCash's own payment id — which we can only learn from the
 * notification itself.
 *
 * So the chain of trust is thinner than it was with the previous provider, and
 * this function is written to fail CLOSED because of it: without a `PmtID` to
 * verify, the answer is PENDING, never PAID. An order therefore cannot be
 * settled by a forged notification alone — the worst it can do is make us ask
 * MaxiCash a question.
 *
 * ponytail: `PmtID` comes from the unverified notification body, so a caller who
 * knows a real PmtID could trigger a genuine verification of someone else's
 * successful payment against OUR order. Three things stand in the way, all in
 * paymentController: only an order we opened a payment on is ever reconciled,
 * one payment id is accepted on one order only, and the reference returned
 * here must match the order. That last check only bites if MaxiCash actually
 * returns the reference — CONFIRM THAT AGAINST A REAL RESPONSE BEFORE TURNING
 * ONLINE PAYMENTS BACK ON, and make a missing reference a refusal if it does.
 */
export const fetchPaymentStatus = async (paymentId: string): Promise<StatusResult> => {
   const cfg = maxicashConfig()

   if (!paymentId) {
      return { outcome: 'PENDING', providerStatus: 'NO_PAYMENT_ID', reference: null, raw: null }
   }

   const data = await postJson(`${cfg.gatewayUrl}/Merchant/api.asmx/PayNowStatus`, {
      PmtID: paymentId,
      PType: 'MaxiCash',
      MerchantID: cfg.merchantId,
      MerchantPassword: cfg.merchantPassword,
      Language: 'en',
   })

   const providerStatus = String(
      data?.ResponseStatus ?? data?.Status ?? data?.ResponseData ?? 'UNKNOWN'
   ).toUpperCase()

   const outcome: SettlementOutcome = SUCCESS_STATUSES.has(providerStatus)
      ? 'PAID'
      : FAILURE_STATUSES.has(providerStatus)
        ? 'FAILED'
        : 'PENDING'

   // Field name is undocumented, so every spelling seen in their other
   // responses is tried.
   const reference =
      data?.Reference ?? data?.reference ?? data?.MerchantReference ?? data?.TransactionReference
   return {
      outcome,
      providerStatus,
      reference: reference ? String(reference).toUpperCase() : null,
      raw: data,
   }
}

/* ------------------------------------------------------------- webhook */

export interface Notification {
   /** Our order reference, as we sent it. */
   reference: string | null
   /** MaxiCash's payment id — the only thing `PayNowStatus` accepts. */
   paymentId: string | null
   /** What the notification claims. Never believed; used only for logging. */
   claimedStatus: string | null
}

/**
 * Pull the fields we need out of a notification, whatever shape it arrives in.
 *
 * MaxiCash does not document the notification body, and the gateway is an
 * ASP.NET application that may send form-encoded POST, JSON, or query-string
 * parameters depending on the flow. Rather than guess one shape and silently
 * ignore the others, this accepts any of them and matches field names
 * case-insensitively.
 *
 * Deliberately does NOT return a "paid" flag. The claimed status is recorded so
 * the office can see what arrived, and then ignored.
 */
export const parseNotification = (sources: Array<Record<string, any> | undefined>): Notification => {
   const flat: Record<string, string> = {}
   for (const src of sources) {
      if (!src || typeof src !== 'object') continue
      for (const [k, v] of Object.entries(src)) {
         if (v === undefined || v === null || typeof v === 'object') continue
         flat[k.toLowerCase()] = String(v)
      }
   }
   const pick = (...names: string[]) => {
      for (const n of names) if (flat[n]) return flat[n]
      return null
   }
   return {
      reference: pick('reference', 'merchantreference', 'orderid', 'order_reference'),
      paymentId: pick('pmtid', 'paymentid', 'transactionid', 'pmt_id', 'logid'),
      claimedStatus: pick('status', 'responsestatus', 'paymentstatus', 'result'),
   }
}
