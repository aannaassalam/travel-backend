import { Model } from 'mongoose'
import slugify from 'slugify'

/**
 * Builds a slug that is unique within a collection.
 *
 * Slugs carry a unique index because they end up in public URLs, so two hotels
 * with the same name in the same city — "Hôtel Central, Kinshasa" is not an
 * unlikely pair — would otherwise collide and fail the insert with a raw
 * MongoDB duplicate-key error.
 *
 * Appends -2, -3 … rather than a timestamp, so the URL stays readable.
 */
export const uniqueSlug = async (
   model: Model<any>,
   parts: (string | undefined)[]
): Promise<string> => {
   const base =
      slugify(parts.filter(Boolean).join('-'), { lower: true, strict: true }) ||
      'listing'

   for (let n = 1; n < 200; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`
      const taken = await model.exists({ slug: candidate })
      if (!taken) return candidate
   }
   // Pathological case only — 200 identically named listings in one city.
   return `${base}-${Date.now()}`
}
