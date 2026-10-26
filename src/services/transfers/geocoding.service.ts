import type { LatLng } from './routing.service'

/**
 * Place search for a pick-up or drop-off the office has not saved: MapTiler's
 * geocoder, limited to the DRC and biased towards the city's centre. Optional —
 * without MAPTILER_KEY the office's own places are all the customer is offered,
 * and the booking works the same. The key stays on this server.
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

/** Up to five places matching `q`, or none — never an error: the search box must not break the page. */
export const searchPlaces = async (q: string, city: string, near?: LatLng): Promise<Suggestion[]> => {
   const key = process.env.MAPTILER_KEY
   const text = q.trim()
   if (!key || text.length < MIN_CHARS) return []

   const cacheKey = `${city.toLowerCase()}|${text.toLowerCase()}`
   const hit = cache.get(cacheKey)
   if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

   let value: Suggestion[] = []
   try {
      const params = new URLSearchParams({ key, country: 'cd', limit: String(LIMIT), language: 'fr' })
      if (near) params.set('proximity', `${near.lng},${near.lat}`)
      const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(text)}.json?${params}`
      const res = await fetch(url, {
         signal: AbortSignal.timeout(Number(process.env.ROUTING_TIMEOUT_MS) || 4000),
      })
      if (!res.ok) throw new Error(`geocoding answered ${res.status}`)
      const json: any = await res.json()
      value = (json?.features ?? [])
         .map((f: any) => ({
            name: String(f.place_name_fr ?? f.place_name ?? f.text ?? '').slice(0, 200),
            lat: Number(f.center?.[1]),
            lng: Number(f.center?.[0]),
            external: true as const,
         }))
         .filter((s: Suggestion) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng) && insideDrc(s))
         .slice(0, LIMIT)
   } catch (err) {
      // The key never travels in the message either: MapTiler puts it in the URL it echoes.
      console.warn(`[geocoding] no suggestions: ${String((err as Error).message).replace(key, '…')}`)
   }
   if (cache.size > 2000) cache.clear()
   cache.set(cacheKey, { at: Date.now(), value })
   return value
}
