import mongoose, { Schema } from 'mongoose'

import { LOCALES } from '../constants/domain.constants'
import { SITE_CONTENT_DEFAULTS } from '../constants/siteContent.defaults'
import AppError from '../utils/appError'
import { isOwnPublicFile } from '../utils/ownFile'
import { Localized } from './shared.schema'

/**
 * The words and pictures on the public website that the office edits itself:
 * the home banner, the About, Contact and Help pages, and the footer.
 *
 * They lived in the website's source, so changing a sentence meant a developer
 * and a deploy — §15 lists exactly that ("making the owner wait for a developer
 * to change a homepage banner") as a thing to avoid.
 *
 * One document, one field per section. Legal texts are NOT here: those are
 * `PolicyVersion`, immutable and versioned, because orders point at them.
 */

type Text = { kind: 'text'; max: number; label: string }
type Image = { kind: 'image'; label: string }
type List = { kind: 'list'; max: number; label: string; of: Text | Record<string, Text> }
type Field = Text | Image | List

const text = (label: string, max: number): Text => ({ kind: 'text', max, label })
const image = (label: string): Image => ({ kind: 'image', label })
const list = (label: string, max: number, of: List['of']): List => ({ kind: 'list', max, label, of })

/**
 * What each section holds, and how long each piece may be. This is the only
 * description of the shape: reading a save, filling in defaults and the limits
 * the editor shows all come from it.
 */
export const SITE_SECTIONS: Record<SiteSection, Record<string, Field>> = {
   home: {
      heroImage: image('Banner picture'),
      heroTitle: text('Headline', 120),
      heroSubtitle: text('Text under the headline', 300),
   },
   about: {
      image: image('Banner picture'),
      title: text('Headline', 160),
      intro: text('Introduction', 600),
      sections: list('Blocks', 8, {
         title: text('Block title', 120),
         body: text('Block text', 1200),
      }),
      listTitle: text('List heading', 120),
      listItems: list('List', 12, text('List line', 400)),
   },
   contact: {
      intro: text('Introduction', 600),
      formTitle: text('Form heading', 120),
      formIntro: text('Text above the form', 400),
   },
   help: {
      intro: text('Introduction', 400),
      faq: list('Questions', 40, {
         question: text('Question', 200),
         answer: text('Answer', 2000),
      }),
      contactTitle: text('Closing heading', 120),
      contactText: text('Closing text', 400),
   },
   footer: {
      tagline: text('Line under the logo', 160),
      notice: text('No-refund reminder', 600),
      copyright: text('Copyright line', 200),
   },
}

export type SiteSection = 'home' | 'about' | 'contact' | 'help' | 'footer'
export const SITE_SECTION_NAMES = ['home', 'about', 'contact', 'help', 'footer'] as const
export type SiteContent = typeof SITE_CONTENT_DEFAULTS

const siteContentSchema = new Schema(
   {
      // Mixed on purpose: `readSection` below is the gate every write passes,
      // and it produces exactly the shape SITE_SECTIONS describes. A second,
      // hand-written copy of that shape here could only drift from it.
      home: Schema.Types.Mixed,
      about: Schema.Types.Mixed,
      contact: Schema.Types.Mixed,
      help: Schema.Types.Mixed,
      footer: Schema.Types.Mixed,
   },
   { timestamps: true, minimize: false }
)

const SiteContentModel = mongoose.model('SiteContent', siteContentSchema)
export default SiteContentModel

/** Saved sections over the built-in wording, so the site is never missing a piece. */
export const getSiteContent = async (): Promise<SiteContent & { updatedAt?: Date }> => {
   const saved: any = (await SiteContentModel.findOne().lean()) ?? {}
   const content: any = {}
   for (const section of SITE_SECTION_NAMES) {
      content[section] = { ...SITE_CONTENT_DEFAULTS[section], ...(saved[section] ?? {}) }
   }
   return { ...content, updatedAt: saved.updatedAt }
}

// --- Reading a save -----------------------------------------------------------

/** One piece of text in each language it was given; French is the one that must be there. */
const readText = (raw: unknown, field: Text, required = true): Localized => {
   if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
      throw new AppError(`${field.label}: text in each language is expected`, 400)
   }
   const out: Localized = {}
   for (const locale of LOCALES) {
      const value = (raw as any)?.[locale]
      if (value === undefined || value === null) continue
      if (typeof value !== 'string') throw new AppError(`${field.label}: text is expected`, 400)
      // NUL would make the driver throw; nothing else is touched — the website
      // prints this as text, never as HTML.
      const clean = value.replace(/\0/g, '').trim()
      if (clean.length > field.max) {
         throw new AppError(
            `${field.label} is limited to ${field.max} characters (${locale.toUpperCase()} has ${clean.length})`,
            400
         )
      }
      if (clean) out[locale] = clean
   }
   if (required && !out.fr) {
      throw new AppError(`${field.label}: the French text is required`, 400)
   }
   return out
}

/**
 * A picture uploaded through the panel, or none. Exactly what the upload on
 * that screen hands back — our storage, the website's own folder, a generated
 * name — and nothing else (see `isOwnPublicFile`).
 */
const readImage = (raw: unknown, field: Image): string => {
   if (raw === undefined || raw === null || raw === '') return ''
   if (!isOwnPublicFile(raw, 'site', '(\\.[a-z0-9]{1,5})?')) {
      throw new AppError(`${field.label}: upload the picture from this screen`, 400)
   }
   return raw
}

const readList = (raw: unknown, field: List): unknown[] => {
   if (raw === undefined || raw === null) return []
   if (!Array.isArray(raw)) throw new AppError(`${field.label}: a list is expected`, 400)
   if (raw.length > field.max) {
      throw new AppError(`${field.label}: at most ${field.max} entries`, 400)
   }
   const of = field.of
   if ('kind' in of) {
      // A line left blank is a line removed, not an error.
      return raw.map((item) => readText(item, of as Text, false)).filter((item) => item.fr)
   }
   return raw.map((item) =>
      Object.fromEntries(
         Object.entries(of as Record<string, Text>).map(([key, part]) => [
            key,
            readText((item as any)?.[key], part),
         ])
      )
   )
}

/** A section exactly as SITE_SECTIONS describes it, or a 400 saying what is wrong. */
export const readSection = (section: SiteSection, body: any) => {
   if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError('Nothing to save', 400)
   }
   return Object.fromEntries(
      Object.entries(SITE_SECTIONS[section]).map(([key, field]) => [
         key,
         field.kind === 'text'
            ? readText(body[key], field)
            : field.kind === 'image'
              ? readImage(body[key], field)
              : readList(body[key], field),
      ])
   )
}
