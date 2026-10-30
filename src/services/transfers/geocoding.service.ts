import type { LatLng } from './routing.service'

/**
 * Place search for a pick-up or drop-off the office has not saved, and the
 * name of a point picked on the map: MapTiler's geocoder, limited to the DRC
 * and biased towards the city's centre. Optional — without MAPTILER_KEY the
 * office's own places are all the customer is offered, a map point is named by
 * its coordinates, and the booking works the same. The key stays on this server.
 */

export interface Suggestion {
   name: string
   lat: number
   lng: number
   external: true
}

/** The DRC, roughly: a suggestion outside it is another country's. */
export const DRC_BOUNDS = { lat: [-14, 6] as const, lng: [12, 32] as const }
export const insideDrc = (p: LatLng) =>
   p.lat >= DRC_BOUNDS.lat[0] && p.lat <= DRC_BOUNDS.lat[1] && p.lng >= DRC_BOUNDS.lng[0] && p.lng <= DRC_BOUNDS.lng[1]

const CACHE_MS = 60_000
const MIN_CHARS = 3
const LIMIT = 5
const cache = new Map<string, { at: number; value: Suggestion[] }>()

export const geocodingEnabled = () => Boolean(process.env.MAPTILER_KEY)

/**
 * MapTiler calls this server makes in an hour, every customer together: the
 * routes' per-IP limits stop one visitor, this caps what a crowd of them (or
 * one rotating its address) can cost on a metered plan. Past it, searches show
 * the office's places only and map points keep their coordinates until the hour turns.
 * ponytail: counted per process; with several instances each has its own allowance.
 */
const callsPerHour = () => Number(process.env.MAPTILER_CALLS_PER_HOUR) || 2000
let hour = -1
let spent = 0
const spend = () => {
   const now = Math.floor(Date.now() / 3_600_000)
   if (now !== hour) {
      hour = now
      spent = 0
   }
   return ++spent <= callsPerHour()
}

/** Layers too wide for a driver to go by, or not somewhere one is driven to: left out of a name. */
const NOT_IN_NAME = new Set(['country', 'continental_marine', 'major_landform', 'postal_code'])
const layerOf = (f: any) => String(f?.id ?? '').split('.')[0]
const textOf = (f: any) => String(f?.text_fr ?? f?.text ?? '').trim()

/**
 * A short name from MapTiler's most specific match: its own name (with the
 * house number, for an address) and then the areas around it, smallest first,
 * without repeats or the country — "Avenue Radio, Lingwala, La Voix du Peuple",
 * "Route nationale 1, Mont Ngafula, Kinshasa". Across a border (Brazzaville,
 * Gisenyi are inside the DRC's rough box) the country is kept, last, so the
 * name says it. Null when nothing usable is left.
 */
export const shortName = (f: any): string | null => {
   if (!f) return null
   const own = NOT_IN_NAME.has(layerOf(f))
      ? []
      : [String(f.place_name_fr ?? f.place_name ?? f.text_fr ?? f.text ?? '').split(',')[0]]
   const context: any[] = Array.isArray(f.context) ? f.context : []
   const around = context.filter((c) => !NOT_IN_NAME.has(layerOf(c))).map(textOf)
   const parts = [...new Set([...own, ...around].map((s) => s.trim()).filter(Boolean))]
   const code = String(f.properties?.country_code ?? '').toLowerCase()
   const country = code && code !== 'cd' ? textOf(context.find((c) => layerOf(c) === 'country')) : ''
   const kept = country ? [...parts.slice(0, 2), country] : parts.slice(0, 3)
   return kept.join(', ').slice(0, 200) || null
}

/** Up to five places matching `q`, or none — never an error: the search box must not break the page. */
export const searchPlaces = async (q: string, city: string, near?: LatLng): Promise<Suggestion[]> => {
   const key = process.env.MAPTILER_KEY
   const text = q.trim()
   if (!key || text.length < MIN_CHARS) return []

   const cacheKey = `${city.toLowerCase()}|${text.toLowerCase()}`
   const hit = cache.get(cacheKey)
   if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
   if (!spend()) return []

   let value: Suggestion[]
   try {
      const params = new URLSearchParams({ key, country: 'cd', limit: String(LIMIT), language: 'fr' })
      if (near) params.set('proximity', `${near.lng.toFixed(6)},${near.lat.toFixed(6)}`)
      const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(text)}.json?${params}`
      const res = await fetch(url, {
         signal: AbortSignal.timeout(Number(process.env.ROUTING_TIMEOUT_MS) || 4000),
      })
      if (!res.ok) throw new Error(`geocoding answered ${res.status}`)
      const json: any = await res.json()
      value = (json?.features ?? [])
         // A country or a landform is not a pick-up point: once its own name is
         // dropped, only the region around it would be left to show.
         .filter((f: any) => !NOT_IN_NAME.has(layerOf(f)))
         .map((f: any) => ({
            // Named as a map point is: no country, no repeats.
            name: shortName(f) ?? '',
            lat: Number(f.center?.[1]),
            lng: Number(f.center?.[0]),
            external: true as const,
         }))
         .filter((s: Suggestion) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng) && insideDrc(s))
         // Two layers of one place (a district and the place inside it) read the same once shortened.
         .filter((s: Suggestion, i: number, all: Suggestion[]) => all.findIndex((o) => o.name === s.name) === i)
         .slice(0, LIMIT)
   } catch (err) {
      // The key never travels in the message either: MapTiler puts it in the URL it echoes.
      console.warn(`[geocoding] no suggestions: ${String((err as Error).message).replace(key, '…')}`)
      // Not cached: the next letter typed asks again.
      return []
   }
   if (cache.size > 2000) cache.clear()
   cache.set(cacheKey, { at: Date.now(), value })
   return value
}

const named = new Map<string, { at: number; value: string | null }>()
/** A point's name changes when the map data does, not between two customers. */
const NAME_CACHE_MS = 60 * 60_000

/**
 * What to call a point dropped on the map, from MapTiler's reverse geocoder:
 * a name, null when there is nothing to call it (or no key), undefined when it
 * could not be asked (MapTiler down or slow, the hour's calls spent). Never an
 * error — the point is booked by its coordinates either way — and an unasked
 * one is not cached, here or by the caller: the next pin there asks again.
 */
export const nameAt = async (p: LatLng): Promise<string | null | undefined> => {
   const key = process.env.MAPTILER_KEY
   if (!key) return null

   // About 10 m: a pin nudged within a doorway is the same address.
   const cacheKey = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`
   const hit = named.get(cacheKey)
   if (hit && Date.now() - hit.at < NAME_CACHE_MS) return hit.value
   if (!spend()) return undefined

   let value: string | null
   try {
      const params = new URLSearchParams({ key, language: 'fr' })
      // Fixed decimals: a raw number can print as 1e-7, which MapTiler does not read.
      const url = `https://api.maptiler.com/geocoding/${p.lng.toFixed(6)},${p.lat.toFixed(6)}.json?${params}`
      const res = await fetch(url, {
         signal: AbortSignal.timeout(Number(process.env.ROUTING_TIMEOUT_MS) || 4000),
      })
      if (!res.ok) throw new Error(`reverse geocoding answered ${res.status}`)
      const json: any = await res.json()
      // One feature per layer, the most specific first.
      value = shortName(json?.features?.[0])
   } catch (err) {
      console.warn(`[geocoding] no name for the point: ${String((err as Error).message).replace(key, '…')}`)
      return undefined
   }
   if (named.size > 5000) named.clear()
   named.set(cacheKey, { at: Date.now(), value })
   return value
}
