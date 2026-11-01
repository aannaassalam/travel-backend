import { Schema } from 'mongoose'
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
   // Every other content language, from the one list (zh, ar, ru were missing
   // here: a strict schema silently dropped what the office typed in them).
   ...Object.fromEntries(
      LOCALES.filter((l) => l !== 'fr').map((l) => [l, { type: String, default: '', trim: true }])
   ),
})

/** A text that may still be the plain string it was before it had languages. */
export type LocalizedText = Localized | string

/**
 * Any stored or sent text as `{ lang: text }`, only the languages with text:
 * a plain string (a record or a panel from before languages) is French, and
 * anything but the content languages is dropped. Also what the public API sends.
 */
export const toLocalized = (value: unknown): Localized => {
   if (typeof value === 'string') return value.trim() ? { fr: value.trim() } : {}
   if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
   const out: Localized = {}
   for (const l of LOCALES) {
      const text = (value as any)[l]
      if (typeof text === 'string' && text.trim()) out[l] = text.trim()
   }
   return out
}

/** Every language, '' where there is none: what the admin edits. */
export const everyLocale = (value: unknown) => {
   const t = toLocalized(value)
   return Object.fromEntries(LOCALES.map((l) => [l, t[l] ?? ''])) as Record<(typeof LOCALES)[number], string>
}

/**
 * A single text that became one per language (2026-10-31). Mixed, so a record
 * that still holds the plain string reads on (as French) with no migration;
 * every write is stored as `toLocalized` makes it. Readers take both shapes.
 */
export const localizedText = (opts: { required?: boolean } = {}) => ({
   type: Schema.Types.Mixed,
   set: toLocalized,
   ...(opts.required
      ? {
           required: true,
           validate: { validator: (v: unknown) => Boolean(toLocalized(v).fr), message: 'French text is required' },
        }
      : {}),
})

/**
 * A localized text from a form, for a field with a length cap: a plain string
 * is French; each language trimmed and held to `max`.
 */
export const parseLocalized = (raw: unknown, label: string, max: number): Localized => {
   if (raw === undefined || raw === null) return {}
   if (typeof raw !== 'string' && (typeof raw !== 'object' || Array.isArray(raw))) {
      throw new AppError(`${label} must be text`, 400)
   }
   const out = toLocalized(raw)
   for (const [l, text] of Object.entries(out)) {
      if (text.length > max) throw new AppError(`${label} is limited to ${max} characters (${l.toUpperCase()})`, 400)
   }
   return out
}

/** A query matching a localized text in any language, or as the plain string it may still be. */
export const localizedMatch = (path: string, value: RegExp) => [
   { [path]: value },
   ...LOCALES.map((l) => ({ [`${path}.${l}`]: value })),
]

// --- Words of a list, translated on the item -----------------------------------

type TagEntry = { tag: string; text: Localized }

/**
 * Each word of an item's lists (amenities, cuisines…) in the other languages.
 * The lists keep the French words, which filters and search use; this says
 * how to show each one. An array, not a map: a word may hold "." or "$".
 * Sent and returned as `{ [frenchWord]: Localized }` — the setter takes that.
 */
export const tagTranslationsField = () => ({
   type: [new Schema({ tag: { type: String, required: true }, text: Schema.Types.Mixed }, { _id: false })],
   default: [],
   set: (v: unknown) =>
      v === null
         ? []
         : typeof v === 'object' && !Array.isArray(v)
           ? Object.entries(v as object).map(([tag, text]) => ({ tag, text: toLocalized(text) }))
           : v,
})

/**
 * On every save: one entry per word the lists still hold, with at least one
 * language besides French (French is the word itself), so a word taken off a
 * list takes its translations with it.
 */
export const keepTagTranslations = (schema: Schema, words: (doc: any) => unknown[]) => {
   schema.pre('validate', function () {
      const doc = this as any
      const kept = new Set(words(doc).filter((w): w is string => typeof w === 'string'))
      const seen = new Set<string>()
      const entries: TagEntry[] = []
      for (const e of doc.tagTranslations ?? []) {
         if (!kept.has(e?.tag) || seen.has(e.tag)) continue
         const text = toLocalized(e.text)
         delete text.fr // the word itself
         if (!Object.keys(text).length) continue
         seen.add(e.tag)
         entries.push({ tag: e.tag, text })
      }
      if (JSON.stringify(entries) !== JSON.stringify((doc.tagTranslations ?? []).map((e: any) => ({ tag: e.tag, text: e.text })))) {
         doc.tagTranslations = entries
      }
   })
}

/**
 * `{ [frenchWord]: Localized }` for the words the lists hold now, French being
 * the word. Admin: every language ('' when empty). Public: only the languages
 * with text, and only words with a translation.
 */
export const tagTranslationsOf = (entries: unknown, words: unknown[], admin: boolean) => {
   const kept = new Set(words)
   // No prototype: a word such as "constructor" is a word like any other.
   const out: Record<string, Localized> = Object.create(null)
   for (const e of (Array.isArray(entries) ? entries : []) as TagEntry[]) {
      if (!kept.has(e?.tag) || out[e.tag]) continue
      const text = toLocalized(e.text)
      delete text.fr
      if (!Object.keys(text).length) continue
      out[e.tag] = admin ? { ...everyLocale(text), fr: e.tag } : { fr: e.tag, ...text }
   }
   return out
}

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
 * Resolve a localised value for display: the asked-for locale, then English,
 * then French (French: French, then English), then any populated translation.
 * Never returns undefined for a record that has any text at all — a blank name
 * in a list is worse than a name in the wrong language.
 */
export const resolveLocalized = (
   value: Localized | string | undefined,
   locale: string = DEFAULT_LOCALE
): string => {
   if (!value) return ''
   if (typeof value === 'string') return value // pre-migration records
   return (
      value[locale as keyof Localized] ||
      value.en ||
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
