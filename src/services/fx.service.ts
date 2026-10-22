import { BASE_CURRENCY, CURRENCIES, Currency } from '../constants/domain.constants'
import SettingsModel from '../model/settingsModel'
import type { Money } from '../model/shared.schema'

/**
 * The currency module.
 *
 * Every price is entered in USD only. Each other currency is worked out from
 * what 1 USD is worth in it, as the office sets in Settings — so a rate change
 * moves every price on the site at once and nobody retypes a catalogue.
 *
 * Held in memory so a price converts without a query: read at boot, right after
 * Settings are saved, and once a minute (another server behind the load
 * balancer may be the one that saved). A currency with no rate set is simply
 * not offered; USD always is.
 *
 * What a customer is charged is fixed when the order is made: the order keeps
 * its own converted total and the rate it used (`fxRate`), so a later rate
 * change never moves a booking already made.
 */

export type Rates = Partial<Record<Currency, number>>

let rates: Rates = {}

/** Only a real, positive rate counts; anything else leaves the currency unset. */
const usable = (raw: unknown): Rates => {
   const out: Rates = {}
   for (const c of CURRENCIES) {
      if (c === BASE_CURRENCY) continue
      const v = Number((raw as any)?.[c])
      if (Number.isFinite(v) && v > 0) out[c] = v
   }
   return out
}

export const refreshRates = async () => {
   const settings = await SettingsModel.findOne().select('exchangeRates').lean()
   rates = usable((settings as any)?.exchangeRates)
   return rates
}

/** Starts the once-a-minute re-read. Never keeps the process alive on its own. */
export const keepRatesFresh = () => {
   setInterval(() => {
      refreshRates().catch((e) => console.error('Could not refresh exchange rates:', e.message))
   }, 60_000).unref()
}

export const currentRates = (): Rates => ({ ...rates })

/** CDF is quoted in whole francs; USD and EUR in cents. */
const EXPONENT: Record<Currency, number> = { USD: 2, EUR: 2, CDF: 0 }

/**
 * USD minor units in another currency's minor units, at the office's rate.
 * Undefined when that currency has no rate.
 *
 * Francs go up to the next hundred: change below that is not given at a till,
 * and rounding down would leave the office short on every sale. Rounded to the
 * franc first, so 29 400.000000004 (floating point) stays 29 400.
 */
export const convert = (usdMinor: number, to: Currency, r: Rates = rates): number | undefined => {
   if (to === BASE_CURRENCY) return usdMinor
   const rate = r[to]
   if (!rate) return undefined
   const amount = (usdMinor / 10 ** EXPONENT.USD) * rate * 10 ** EXPONENT[to]
   return to === 'CDF' ? Math.ceil(Math.round(amount) / 100) * 100 : Math.round(amount)
}

/** A USD price in every currency that has a rate: USD as stored, the rest worked out. */
export const inAllCurrencies = (money: Money | number | undefined, r: Rates = rates): Money => {
   const usd = typeof money === 'number' ? money : (money?.[BASE_CURRENCY as Currency] ?? 0)
   const out: Money = { USD: usd }
   for (const c of CURRENCIES) {
      const v = convert(usd, c, r)
      if (c !== BASE_CURRENCY && v !== undefined) out[c] = v
   }
   return out
}

// Self-check: `npx ts-node --transpile-only src/services/fx.service.ts`
if (require.main === module) {
   const assert: typeof import('assert') = require('assert')
   const r: Rates = { CDF: 2800, EUR: 0.92 }
   assert.strictEqual(convert(1000, 'USD', r), 1000)
   assert.strictEqual(convert(1000, 'CDF', r), 28_000) // $10.00 → 28 000 FC
   assert.strictEqual(convert(1050, 'CDF', r), 29_400) // float noise does not round up
   assert.strictEqual(convert(1234, 'CDF', r), 34_600) // 34 552 → next hundred
   assert.strictEqual(convert(1000, 'EUR', r), 920) // €9.20
   assert.strictEqual(convert(1000, 'EUR', {}), undefined) // no rate, no price
   assert.deepStrictEqual(inAllCurrencies({ USD: 500, CDF: 1 }, r), { USD: 500, CDF: 14_000, EUR: 460 })
   assert.deepStrictEqual(inAllCurrencies(500, { CDF: 2800 }), { USD: 500, CDF: 14_000 })
   assert.deepStrictEqual(usable({ CDF: '2850', EUR: -1, USD: 3 }), { CDF: 2850 })
   console.log('fx.service: ok')
}
