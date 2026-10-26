/**
 * Road distance between two points, for pricing a transfer and drawing it.
 *
 * Asks an OSRM server (ROUTING_URL, the public demo server by default) and,
 * when it cannot answer in time, falls back to the straight line times a detour
 * factor — a quote must come back whether or not a third party is up. The
 * answer says which it was (`source`), so the customer's screen can say
 * "estimated".
 */

export interface LatLng {
   lat: number
   lng: number
}

export interface Distance {
   /** One decimal. Never 0 for two distinct points. */
   km: number
   minutes: number
   /** `[lng, lat]` points to draw; the straight line when estimated. */
   route?: number[][]
   source: 'ROUTING' | 'ESTIMATE'
}

/** Points kept on a drawn route; a long drive is thinned evenly to this. */
export const ROUTE_POINTS_MAX = 500
/** Average town speed the estimate assumes. */
const ESTIMATE_KMH = 30
const CACHE_MS = 10 * 60_000
/** A fresh OSRM demo-server answer can take a while from Kinshasa; beyond this it is estimated. */
const timeoutMs = () => Number(process.env.ROUTING_TIMEOUT_MS) || 4000
const routingUrl = () => (process.env.ROUTING_URL || 'https://router.project-osrm.org').replace(/\/$/, '')

const round1 = (n: number) => Math.round(n * 10) / 10

const EARTH_KM = 6371
const rad = (deg: number) => (deg * Math.PI) / 180

/** Great-circle distance in km. */
export const haversineKm = (a: LatLng, b: LatLng) => {
   const dLat = rad(b.lat - a.lat)
   const dLng = rad(b.lng - a.lng)
   const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
   return 2 * EARTH_KM * Math.asin(Math.sqrt(h))
}

/** The straight line, stretched by the detour factor roads add, at town speed. */
export const estimate = (a: LatLng, b: LatLng, detourFactor = 1.3): Distance => {
   const km = Math.max(0.1, round1(haversineKm(a, b) * detourFactor))
   return {
      km,
      minutes: Math.max(1, Math.round((km / ESTIMATE_KMH) * 60)),
      route: [
         [a.lng, a.lat],
         [b.lng, b.lat],
      ],
      source: 'ESTIMATE',
   }
}

/** At most `max` points, taken evenly, the first and the last always kept. */
export const sampleRoute = (points: number[][], max = ROUTE_POINTS_MAX): number[][] => {
   if (points.length <= max) return points
   const step = (points.length - 1) / (max - 1)
   return Array.from({ length: max }, (_, i) => points[Math.round(i * step)])
}

const cache = new Map<string, { at: number; value: Distance }>()
const keyOf = (a: LatLng, b: LatLng) =>
   `${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`

const fromRouting = async (a: LatLng, b: LatLng): Promise<Distance> => {
   const url =
      `${routingUrl()}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}` +
      '?overview=simplified&geometries=geojson'
   const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs()) })
   if (!res.ok) throw new Error(`routing answered ${res.status}`)
   const json: any = await res.json()
   const route = json?.routes?.[0]
   if (json?.code !== 'Ok' || !route) throw new Error('routing found no road')
   return {
      km: Math.max(0.1, round1(Number(route.distance) / 1000)),
      minutes: Math.max(1, Math.round(Number(route.duration) / 60)),
      route: sampleRoute(
         (route.geometry?.coordinates ?? []).filter(
            (p: unknown) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n))
         )
      ),
      source: 'ROUTING',
   }
}

/**
 * Road distance from a to b. Cached ten minutes on the coordinates rounded to
 * four decimals (about 10 m): the same quote is asked for every category card
 * and again at checkout.
 */
export const distanceBetween = async (a: LatLng, b: LatLng, detourFactor = 1.3): Promise<Distance> => {
   const key = keyOf(a, b)
   const hit = cache.get(key)
   if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

   let value: Distance
   try {
      value = await fromRouting(a, b)
   } catch (err) {
      console.warn(`[routing] estimated instead: ${(err as Error).message}`)
      value = estimate(a, b, detourFactor)
   }
   // ponytail: a plain Map with a size cap, no LRU. Enough for one server
   // quoting a few cities; swap for an LRU if the key space ever grows.
   if (cache.size > 5000) cache.clear()
   cache.set(key, { at: Date.now(), value })
   return value
}
