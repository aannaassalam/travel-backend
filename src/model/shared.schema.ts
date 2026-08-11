import {
   BASE_CURRENCY,
   CURRENCIES,
   Currency,
   DEFAULT_LOCALE,
   LOCALES,
} from '../constants/domain.constants'

/**
 * Building blocks shared by every sellable thing: localised text and money.
 * Defined once so hotels, room types and listings cannot drift apart.
 */

export type Localized = Partial<Record<(typeof LOCALES)[number], string>>

/**
 * Localised text. Every customer-facing string — names included, not just
 * descriptions — so the public site renders the visitor's language rather than
 * one language for everyone.
 */
export const localizedField = (opts: { required?: boolean } = {}) => ({
   fr: {
      type: String,
      default: '',
      trim: true,
      // French is the default locale, so it is the fallback everything else
      // resolves to — it is the one that cannot be blank.
      required: opts.required ? [true, 'French text is required'] : false,
   },
   en: { type: String, default: '', trim: true },
   pt: { type: String, default: '', trim: true },
   es: { type: String, default: '', trim: true },
})

/**
 * Resolve a localised value for display: asked-for locale, then the default
 * locale, then any populated translation. Never returns undefined for a record
 * that has any text at all — a blank name in a list is worse than a name in the
 * wrong language.
 */
export const resolveLocalized = (
   value: Localized | string | undefined,
   locale: string = DEFAULT_LOCALE
): string => {
   if (!value) return ''
   if (typeof value === 'string') return value // pre-migration records
   return (
      value[locale as keyof Localized] ||
      value[DEFAULT_LOCALE] ||
      LOCALES.map((l) => value[l]).find(Boolean) ||
      ''
   )
}

/** Which locales actually have text — drives the FR ✓ EN ✗ indicator (§5.1). */
export const translationStatus = (value: Localized | string | undefined) => {
   const v = typeof value === 'string' ? { [DEFAULT_LOCALE]: value } : value || {}
   return Object.fromEntries(
      LOCALES.map((l) => [l, Boolean((v as Localized)[l])])
   ) as Record<string, boolean>
}

// ---------------------------------------------------------------------------

export type Money = Partial<Record<Currency, number>>

/**
 * Prices, per currency, in integer minor units.
 *
 * Each currency is entered explicitly by the administrator rather than
 * converted at read time. A converted price drifts with the FX rate between the
 * moment a customer sees it and the moment they pay, and under a no-refund
 * policy that difference is not something anyone wants to argue about. What the
 * administrator typed is what the customer is charged.
 *
 * USD remains mandatory: it is the reporting base. Margin, spoilage,
 * sell-through and every dashboard total have to aggregate in ONE currency, and
 * a catalogue priced only in CDF could not be summed against one priced only in
 * EUR. Other currencies are optional — an unset one simply is not offered.
 */
export const moneyField = (opts: { required?: boolean } = {}) => ({
   USD: {
      type: Number,
      min: 0,
      required: opts.required
         ? [true, 'A USD price is required — it is the reporting base']
         : false,
      default: opts.required ? undefined : 0,
   },
   CDF: { type: Number, min: 0 },
   EUR: { type: Number, min: 0 },
})

/** The base-currency amount, which is what all reporting sums. */
export const baseAmount = (money: Money | number | undefined): number => {
   if (typeof money === 'number') return money // pre-migration records
   return money?.[BASE_CURRENCY as Currency] ?? 0
}

/** Currencies this record can actually be sold in — those with a real price. */
export const availableCurrencies = (money: Money | number | undefined): Currency[] => {
   if (typeof money === 'number') return [BASE_CURRENCY as Currency]
   return CURRENCIES.filter((c) => typeof money?.[c] === 'number' && money[c]! > 0)
}

/** Normalises form input, dropping blanks so an empty box never becomes 0. */
export const parseMoney = (input: any): Money | undefined => {
   if (input === undefined || input === null) return undefined
   if (typeof input === 'number') return { USD: input }
   const out: Money = {}
   CURRENCIES.forEach((c) => {
      const v = input[c]
      if (v === '' || v === null || v === undefined) return
      const n = Number(v)
      if (!Number.isNaN(n)) out[c] = Math.round(n)
   })
   return out
}
