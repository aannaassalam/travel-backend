import { BASE_CURRENCY, CURRENCIES, Currency } from '../constants/domain.constants'
import SettingsModel from '../model/settingsModel'
import type { Money } from '../model/shared.schema'

/**
 * The currency module.
 *
 * Every price is entered in Congolese francs only. Each other currency is
 * worked out from how many francs 1 USD and 1 EUR are worth, as the office
 * types them in Settings — so a rate change moves every price on the site at
 * once and nobody retypes a catalogue.
 *
 * Held in memory so a price converts without a query: read at boot, right after
 * Settings are saved, and once a minute (another server behind the load
 * balancer may be the one that saved). A currency with no rate set is simply
 * not offered; CDF always is.
 *
 * What a customer is charged is fixed when the order is made: the order keeps
 * its own converted total and the rate it used (`fxRate`, francs per 1 unit of
 * the charged currency), so a later rate change never moves a booking already
 * made.
 */

/** Francs per 1 unit of each other currency: `{ USD: 2850, EUR: 3100 }`. */
export type Rates = Partial<Record<Currency, number>>

let rates: Rates = {}

/**
 * Only a real, positive rate counts; anything else leaves the currency unset.
 *
 * Rates stored before francs became the base (CDF = francs per dollar, EUR =
 * euros per dollar) offer nothing until scripts/migrateCdfBase rewrites them:
 * that EUR of 0.92, read as francs, would sell a euro for under one franc.
 */
const usable = (raw: unknown): Rates => {
   const out: Rates = {}
   if (raw && typeof raw === 'object' && 'CDF' in raw) return out
   for (const c of CURRENCIES) {
      if (c === BASE_CURRENCY) continue
      const v = Number((raw as any)?.[c])
      if (Number.isFinite(v) && v > 0) out[c] = v
   }
   return out
}

/** Francs per euro from francs and euros per dollar, to the centime as the office types it. */
export const francsPerEuro = (francsPerUsd: number, eurosPerUsd: number) =>
   Math.round((francsPerUsd / eurosPerUsd) * 100) / 100

/**
 * Why `raw` cannot be how many francs 1 USD or 1 EUR buys, or null when it can:
 * 100 to 100 000 (about 2 300–3 000 in 2026). A figure turned the other way
 * round is named: 0.00043 typed for 2 300 priced everything at 0 FC on 2026-10-26.
 */
export const francRateProblem = (currency: 'USD' | 'EUR', raw: unknown): string | null => {
   const n = Number(raw)
   if (Number.isFinite(n) && n >= 100 && n <= 100_000) return null
   const unit = currency === 'USD' ? 'dollar' : 'euro'
   const flipped =
      n > 0 && n < 1
         ? ` ${raw} is ${unit}s per franc; the other way round, 1 ${currency} = ${Math.round(1 / n).toLocaleString('en-GB')} FC.`
         : ''
   return `1 ${currency} = ${raw} FC cannot be right: enter how many francs one ${unit} buys, between 100 and 100,000 (like 2,850).${flipped}`
}

/**
 * Stored rates as francs per 1 unit: what Settings shows, and what a save
 * keeps of a box it was not sent. Rates from before francs became the base
 * read as the francs they stand for (what scripts/migrateCdfBase writes):
 * shown as stored, that EUR of 0.92 would read "1 EUR = 0.92 FC", and saving
 * any setting would then store it so. Takes the raw value
 * (`doc.get('exchangeRates')`): a document's own `exchangeRates` hides the old CDF.
 */
export const ratesInFrancs = (raw: any): Rates => {
   if (!raw || typeof raw !== 'object' || !('CDF' in raw)) return { USD: raw?.USD, EUR: raw?.EUR }
   const usd = Number(raw.CDF) > 0 ? Number(raw.CDF) : undefined
   return { USD: usd, EUR: usd && Number(raw.EUR) > 0 ? francsPerEuro(usd, Number(raw.EUR)) : undefined }
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

/**
 * Whole francs in another currency, in its cents, at the office's rate.
 * Undefined when that currency has no rate.
 *
 * Rounded UP to the cent, so the office is never short on a sale. toFixed(6)
 * first kills float noise: 399 FC at 2 850 is 14.000000000000002 cents, which
 * is 14, not 15.
 *
 * The website and the app work out the same figure the same way.
 */
export const convert = (cdf: number, to: Currency, r: Rates = rates): number | undefined => {
   if (to === BASE_CURRENCY) return cdf
   const rate = r[to]
   if (!rate) return undefined
   return Math.ceil(Number((cdf / rate * 100).toFixed(6)))
}

/** A franc price in every currency that has a rate: CDF as stored, the rest worked out. */
export const inAllCurrencies = (money: Money | number | undefined, r: Rates = rates): Money => {
   const cdf = typeof money === 'number' ? money : (money?.[BASE_CURRENCY as Currency] ?? 0)
   const out: Money = { CDF: cdf }
   for (const c of CURRENCIES) {
      const v = convert(cdf, c, r)
      if (c !== BASE_CURRENCY && v !== undefined) out[c] = v
   }
   return out
}

// Self-check: `npx ts-node --transpile-only src/services/fx.service.ts`
if (require.main === module) {
   const assert: typeof import('assert') = require('assert')
   const r: Rates = { USD: 2850, EUR: 3100 }
   assert.strictEqual(convert(10_000, 'CDF', r), 10_000)
   assert.strictEqual(convert(10_000, 'USD', r), 351) // 350.877… cents → $3.51
   assert.strictEqual(convert(10_000, 'EUR', r), 323) // 322.58… cents → €3.23
   assert.strictEqual(convert(513_000, 'USD', r), 18_000) // exactly $180.00
   assert.strictEqual(convert(399, 'USD', r), 14) // float noise does not round up
   assert.strictEqual(convert(1, 'USD', r), 1) // up, never down: one cent
   assert.strictEqual(convert(0, 'USD', r), 0)
   assert.strictEqual(convert(10_000, 'EUR', {}), undefined) // no rate, no price
   // A legacy dollar figure on the record is never read.
   assert.deepStrictEqual(inAllCurrencies({ CDF: 10_000, USD: 999 }, r), { CDF: 10_000, USD: 351, EUR: 323 })
   assert.deepStrictEqual(inAllCurrencies(10_000, { USD: 2850 }), { CDF: 10_000, USD: 351 })
   assert.deepStrictEqual(inAllCurrencies({ USD: 18_000 } as Money, r), { CDF: 0, USD: 0, EUR: 0 })
   assert.deepStrictEqual(usable({ USD: '2850', EUR: -1, CDF_: 3 }), { USD: 2850 })
   assert.deepStrictEqual(usable({ CDF: 2850, EUR: 0.92 }), {}) // the shape before francs
   assert.deepStrictEqual(ratesInFrancs({ CDF: 2850, EUR: 0.92 }), { USD: 2850, EUR: 3097.83 })
   assert.deepStrictEqual(ratesInFrancs({ CDF: 2850 }), { USD: 2850, EUR: undefined })
   assert.deepStrictEqual(ratesInFrancs({ USD: 2850, EUR: 3100 }), { USD: 2850, EUR: 3100 })
   assert.deepStrictEqual(ratesInFrancs(undefined), { USD: undefined, EUR: undefined })
   assert.deepStrictEqual(usable(undefined), {})
   console.log('fx.service: ok')
}
