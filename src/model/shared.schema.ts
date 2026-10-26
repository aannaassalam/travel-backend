import {
   BASE_CURRENCY,
   Currency,
   DEFAULT_LOCALE,
   LOCALES,
} from '../constants/domain.constants'
import AppError from '../utils/appError'
import { isOwnPublicFile } from '../utils/ownFile'
import { inAllCurrencies } from '../services/fx.service'

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

/** Where the admin's video upload stores its files, and what it stores them as. */
export const VIDEO_FOLDER = 'videos'
const VIDEO_EXTENSION = '\\.(mp4|webm)'

/**
 * The optional video of a hotel, restaurant or listing: the address the
 * panel's video upload answered with, and no other — it goes into a <video>
 * on a page every visitor loads. A blank clears it.
 */
export const videoField = () => ({
   type: String,
   set: (v: unknown) => {
      const text = v === null || v === undefined ? '' : String(v).trim()
      return text || undefined
   },
   validate: {
      // Judged when it is set, not on every later save of the record: if the
      // storage ever moves to another address, a video stored under the old
      // one must not make its hotel impossible to edit until someone removes it.
      validator: function (this: any, v: string) {
         if (!v || this?.isModified?.('videoUrl') === false) return true
         return isOwnPublicFile(v, VIDEO_FOLDER, VIDEO_EXTENSION, false)
      },
      message: 'Video: upload the video from the form',
   },
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
 * A price, in whole Congolese francs.
 *
 * Prices are entered in francs only. USD and EUR are worked out at read time
 * from the office's exchange rates (services/fx.service), so changing a rate
 * moves every price at once and nobody retypes a catalogue. What a customer
 * pays is fixed when their order is made: the order keeps its converted total
 * and the rate it used.
 *
 * Stored as `{ CDF }`. `USD` and `EUR` stay in the schema, unread: prices were
 * dollars until 2026-10-24, and a record the conversion (scripts/migrateCdfBase)
 * has not reached yet must not lose its dollar figure when this code saves it.
 * A price is always written whole, so a new one never carries them.
 *
 * CDF is the reporting base: margin, spoilage and every dashboard total sum it.
 */
export const moneyField = (opts: { required?: boolean } = {}) => ({
   CDF: {
      type: Number,
      min: 0,
      required: opts.required
         ? [true, 'A price in francs (CDF) is required — it is the reporting base']
         : false,
      default: opts.required ? undefined : 0,
   },
   USD: { type: Number, min: 0 },
   EUR: { type: Number, min: 0 },
})

/** The base-currency amount, which is what all reporting sums. */
export const baseAmount = (money: Money | number | undefined): number => {
   if (typeof money === 'number') return money // pre-migration records
   return money?.[BASE_CURRENCY as Currency] ?? 0
}

/** Currencies this record can be sold in: CDF, and each one with a rate set. */
export const availableCurrencies = (money: Money | number | undefined): Currency[] =>
   baseAmount(money) > 0 ? (Object.keys(inAllCurrencies(money)) as Currency[]) : []

/**
 * Form input to a stored price: whole francs only (any other currency sent is
 * ignored — it is worked out, never typed). A blank box is "not set", never 0,
 * so `{}` comes back for it.
 *
 * A dollar price with no francs is a panel still open from before prices were
 * in francs: refused, because read as blank it would wipe the price it meant to set.
 */
export const parseMoney = (input: any): Money | undefined => {
   if (input === undefined || input === null) return undefined
   const v = typeof input === 'number' ? input : input[BASE_CURRENCY]
   const blank = v === '' || v === null || v === undefined
   if (blank && ![undefined, null, ''].includes(input.USD)) {
      throw new AppError('Prices are now entered in Congolese francs: reload the page and enter the price in FC', 400)
   }
   if (blank) return {}
   const n = Number(v)
   return Number.isNaN(n) ? {} : { CDF: Math.round(n) }
}

// ---------------------------------------------------------------------------

export type GeoPoint = { lat: number; lng: number }

/**
 * Map pin from a form: `{ lat, lng }` as numbers, `null` to clear the pin,
 * `undefined` to leave it alone. Anything else is refused rather than cast —
 * a string that happens to cast, or a NaN that does not, is how a pin ends up
 * in the sea.
 */
export const parseGeo = (input: unknown): GeoPoint | null | undefined => {
   if (input === undefined) return undefined
   if (input === null) return null
   const g = input as any
   const ok =
      typeof g === 'object' &&
      !Array.isArray(g) &&
      Object.keys(g).every((k) => k === 'lat' || k === 'lng') &&
      typeof g.lat === 'number' &&
      typeof g.lng === 'number' &&
      g.lat >= -90 &&
      g.lat <= 90 &&
      g.lng >= -180 &&
      g.lng <= 180
   if (!ok) {
      throw new AppError(
         'geo must be { lat, lng } with lat between -90 and 90 and lng between -180 and 180, or null to clear it',
         400
      )
   }
   return { lat: g.lat, lng: g.lng }
}

/**
 * The pin for a response, only when both coordinates are set. An unset nested
 * path reads as `{}` on a document and as `null` once cleared — neither is a
 * place on a map.
 */
export const geoPoint = (g: Partial<GeoPoint> | null | undefined): GeoPoint | undefined =>
   typeof g?.lat === 'number' && typeof g?.lng === 'number'
      ? { lat: g.lat, lng: g.lng }
      : undefined
