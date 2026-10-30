import { isDeepStrictEqual } from 'node:util'

import { PREVIOUS_SITE_WORDING } from '../constants/siteContent.defaults'
import { Hotel } from '../model/hotelModel'
import { Listing } from '../model/listingModel'
import SiteContentModel, { getSiteContent, SITE_SECTION_NAMES, SITE_SECTIONS, SiteSection } from '../model/siteContentModel'
import { systemAudit } from './scheduledJobs.service'

/**
 * Wording that still promises no refund, or only "up to 80%" (the client's
 * wording of 2026-10-26, which the office may have typed itself). Bookings
 * are 80% refundable after deducting processing fees since 2026-10-29; this
 * is how the website content and the published legal texts are checked for
 * the old promise. `.` rather than `\s` between the words: Mongo runs this
 * too, and its `\s` misses the no-break space before "%".
 */
export const NO_REFUND_WORDING =
   /non[- ]?rembours|aucun remboursement|pas rembours|ne rembours|non[- ]?refundable|no[- ]refund|not refunded|do not refund|réservations? (sont )?définitives?|ventes sont définitives|final booking|bookings are final|sales are final|jusqu.{0,3}[àa].{0,2}80.{0,2}%|up to 80.{0,2}%/i

const says = (text: unknown) =>
   Object.values(text ?? {}).some((v) => typeof v === 'string' && NO_REFUND_WORDING.test(v))

/** An entry named by the start of its French text, cut at a word: `"Nous ne remboursons pas. Toutes les…"`. */
const quote = (text: any) => {
   const s = String(text?.fr ?? '')
   // One character past the cut, so a word ending exactly there is kept.
   return `"${s.length > 40 ? `${s.slice(0, 41).replace(/\s+\S*$/, '')}…` : s}"`
}

/**
 * Offers and hotels whose own texts (fare rules, hotel conditions,
 * descriptions) still carry the old wording. Listed for the office, never
 * rewritten: an airline's fare rules can genuinely be its own.
 */
export const staleCatalogue = async (limit = 50) => {
   const described = [{ 'description.fr': NO_REFUND_WORDING }, { 'description.en': NO_REFUND_WORDING }]
   const offers = { status: { $ne: 'ARCHIVED' }, $or: [{ 'attributes.fareRules': NO_REFUND_WORDING }, ...described] }
   const stays = { status: { $ne: 'ARCHIVED' }, $or: [{ policies: NO_REFUND_WORDING }, ...described] }
   const [listings, listingCount, hotels, hotelCount] = await Promise.all([
      Listing.find(offers).select('title vertical').sort({ vertical: 1, _id: 1 }).limit(limit).lean(),
      Listing.countDocuments(offers),
      Hotel.find(stays).select('name').sort({ _id: 1 }).limit(limit).lean(),
      Hotel.countDocuments(stays),
   ])
   const name = (l: any) => l?.fr || l?.en || ''
   return {
      listings: listings.map((l: any) => ({ id: String(l._id), vertical: String(l.vertical), label: name(l.title) })),
      listingCount,
      hotels: hotels.map((h: any) => ({ id: String(h._id), label: name(h.name) })),
      hotelCount,
   }
}

/**
 * Every place in the website content (each language) that still carries the
 * old cancellation wording, named so the office can find it: `Footer → Conditions
 * title`, `Help → "Puis-je annuler et être remboursé ?" (answer)`.
 */
export const staleWording = (content: Record<string, any>) => {
   const found: { section: SiteSection; label: string }[] = []
   for (const section of SITE_SECTION_NAMES) {
      const page = section.charAt(0).toUpperCase() + section.slice(1)
      for (const [key, field] of Object.entries(SITE_SECTIONS[section])) {
         const value = content[section]?.[key]
         if (field.kind === 'text' && says(value)) found.push({ section, label: `${page} → ${field.label}` })
         if (field.kind !== 'list' || !Array.isArray(value)) continue
         for (const entry of value) {
            if ('kind' in field.of) {
               const line = (field.of as { label: string }).label.toLowerCase()
               if (says(entry)) found.push({ section, label: `${page} → ${quote(entry)} (${line})` })
               continue
            }
            const parts = Object.entries(field.of as Record<string, { label: string }>)
            for (const [part, of] of parts) {
               if (says(entry?.[part])) {
                  found.push({ section, label: `${page} → ${quote(entry?.[parts[0][0]])} (${of.label.toLowerCase()})` })
               }
            }
         }
      }
   }
   return found
}

/**
 * The panel saves whole sections, so a section the office ever saved holds the
 * defaults of that day word for word, and new defaults never reach it. At each
 * boot, a text that is still exactly an old default takes its new wording;
 * anything the office changed (one word, an added language) is left alone.
 * Then the texts that still carry the old wording are named in the server log.
 *
 * Idempotent. Written on the raw collection, so `updatedAt` — "last saved" in
 * the panel — does not move: the office did not save.
 */
export const refreshStandardWording = async () => {
   const catalogue = await staleCatalogue(1)
   if (catalogue.listingCount || catalogue.hotelCount) {
      console.warn(
         `Offers whose own texts still use the old cancellation wording (no refund, or up to 80%) — listed in the admin under Website content: ${catalogue.listingCount} offer(s), ${catalogue.hotelCount} hotel(s)`
      )
   }

   const saved: any = await SiteContentModel.collection.findOne({})
   if (!saved) return [] // nothing saved: the site shows the new defaults

   const set: Record<string, unknown> = {}
   for (const { path, old, now } of PREVIOUS_SITE_WORDING) {
      const [section, field, part] = path.replace('[]', '').split('.')
      const value = saved[section]?.[field]
      if (!path.includes('[]')) {
         if (isDeepStrictEqual(value, old)) set[`${section}.${field}`] = now
         continue
      }
      // A list: matched by the text, wherever the office moved the entry.
      ;(Array.isArray(value) ? value : []).forEach((entry, i) => {
         if (isDeepStrictEqual(part ? entry?.[part] : entry, old)) {
            set[`${section}.${field}.${i}${part ? `.${part}` : ''}`] = now
         }
      })
   }

   const paths = Object.keys(set)
   if (paths.length) {
      await SiteContentModel.collection.updateOne({ _id: saved._id }, { $set: set })
      console.log(`Website wording brought up to date (old defaults nobody had changed): ${paths.join(', ')}`)
      await systemAudit('SITE_WORDING_UPDATED', { paths })
   }

   const stale = staleWording(await getSiteContent())
   if (stale.length) {
      console.warn(
         `The website still uses the old cancellation wording (no refund, or up to 80%) here — edit it in the admin under Website content: ${stale
            .map((s) => s.label)
            .join('; ')}`
      )
   }
   return paths
}
