/**
 * Seeds `locations` and `serviced_routes` from the inventory that already
 * exists, so switching the site over to the managed list changes nothing the
 * customer can see.
 *
 *   npx ts-node --transpile-only src/scripts/seedLocations.ts
 *
 * Additive and idempotent: it never deletes, and re-running only fills gaps.
 * Every city is taken from published listings, so the seeded list is exactly
 * what the site was already offering — the difference is that from now on the
 * office owns it instead of a hardcoded array in the website bundle.
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { buildMongoUri } from '../config/db.config'
import { VERTICALS } from '../constants/domain.constants'
import { Hotel } from '../model/hotelModel'
import { Listing } from '../model/listingModel'
import { Location, ServicedRoute } from '../model/locationModel'

dotenv.config()

/**
 * Known metadata for the DRC cities in play. Anything else still gets a row.
 *
 * `order` is what puts the major cities in front of the small towns a coach
 * happens to stop at — the homepage tiles and the "popular destinations" chips
 * both sort by it, and without it they order alphabetically and lead with
 * Bunia and Kasangulu. The office can re-order them from the Locations screen.
 */
const KNOWN: Record<string, { iata?: string; province?: string; image?: string; order?: number }> = {
   Kinshasa: { order: 1, iata: 'FIH', province: 'Kinshasa', image: '/img/photos/kinshasa.webp' },
   Lubumbashi: { order: 2, iata: 'FBM', province: 'Haut-Katanga', image: '/img/photos/lubumbashi.webp' },
   Goma: { order: 3, iata: 'GOM', province: 'Nord-Kivu', image: '/img/photos/goma.webp' },
   Bukavu: { order: 4, iata: 'BKY', province: 'Sud-Kivu', image: '/img/photos/bukavu.webp' },
   Matadi: { order: 5, iata: 'MAT', province: 'Kongo-Central', image: '/img/photos/matadi.webp' },
   Kisangani: { order: 6, iata: 'FKI', province: 'Tshopo', image: '/img/photos/kisangani.webp' },
   'Mbuji-Mayi': { order: 7, iata: 'MJM', province: 'Kasaï-Oriental', image: '/img/photos/mbuji-mayi.webp' },
   Kananga: { order: 8, iata: 'KGA', province: 'Kasaï-Central', image: '/img/photos/kananga.webp' },
}

const slugify = (s: string) =>
   s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

async function main() {
   await mongoose.connect(buildMongoUri())
   console.log(`connected to ${mongoose.connection.name}\n`)

   // --- which cities does each vertical actually sell in? --------------------
   const servesByCity = new Map<string, Set<string>>()
   const add = (city: string, vertical: string) => {
      if (!city?.trim()) return
      const key = city.trim()
      if (!servesByCity.has(key)) servesByCity.set(key, new Set())
      servesByCity.get(key)!.add(vertical)
   }

   for (const l of await Listing.find({}).select('city vertical attributes')) {
      add(l.city, l.vertical)
      /**
       * Every stop on a coach route is a place we service, not just the two
       * ends — someone boarding at Mbanza-Ngungu is a customer, and leaving
       * those out means the search box cannot offer a town the bus stops in.
       */
      if (l.vertical === VERTICALS.BUS) {
         for (const stop of (l as any).attributes?.routeStops ?? []) add(stop, VERTICALS.BUS)
      }
   }
   for (const h of await Hotel.find({}).select('city')) add((h as any).city, VERTICALS.HOTEL)

   let created = 0
   let updated = 0
   for (const [name, verticals] of servesByCity) {
      const meta = KNOWN[name] ?? {}
      const slug = slugify(name)
      const existing = await Location.findOne({ slug })
      if (existing) {
         // Only widen what it serves — never narrow, in case the office has
         // already ticked a vertical by hand for inventory not yet loaded.
         const merged = Array.from(new Set([...existing.servesVerticals, ...verticals]))
         const patch: Record<string, unknown> = {}
         if (merged.length !== existing.servesVerticals.length) patch.servesVerticals = merged
         // Backfill ordering and imagery onto rows seeded before they existed.
         if (existing.sortOrder === 0 && meta.order) patch.sortOrder = meta.order
         if (existing.sortOrder === 0 && !meta.order) patch.sortOrder = 100
         if (!existing.image && meta.image) patch.image = meta.image
         if (!existing.iata && meta.iata) patch.iata = meta.iata
         if (Object.keys(patch).length) {
            await Location.updateOne({ _id: existing._id }, { $set: patch })
            updated++
         }
         continue
      }
      await Location.create({
         name,
         slug,
         country: 'CD',
         province: meta.province,
         iata: meta.iata,
         kind: 'CITY',
         servesVerticals: Array.from(verticals),
         isActive: true,
         // Unlisted towns fall to the back rather than jumbling with the cities.
         sortOrder: meta.order ?? 100,
         image: meta.image,
      })
      created++
   }
   console.log(`locations: ${created} created, ${updated} widened, ${servesByCity.size} total seen`)

   // --- routes, from the pairs already on sale -------------------------------
   const byName = new Map<string, any>()
   for (const loc of await Location.find({})) byName.set(loc.name, loc)

   // Flights identify airports by IATA code, not by city name.
   const byIata = new Map<string, any>()
   for (const loc of await Location.find({ iata: { $exists: true, $ne: null } })) {
      if (loc.iata) byIata.set(loc.iata, loc)
   }

   let routes = 0
   for (const vertical of [VERTICALS.FLIGHT, VERTICALS.BUS]) {
      const listings = await Listing.find({ vertical }).select('city attributes')
      const pairs = new Set<string>()
      for (const l of listings) {
         const attrs = (l as any).attributes ?? {}
         if (vertical === VERTICALS.FLIGHT) {
            // One route per leg, so a connection seeds both hops.
            for (const s of attrs.segments ?? []) {
               const o = byIata.get(String(s.origin).toUpperCase())
               const d = byIata.get(String(s.destination).toUpperCase())
               if (o && d && !o._id.equals(d._id)) pairs.add(`${o._id}|${d._id}`)
            }
         } else {
            // A coach route's endpoints are the first and last stop.
            const stops: string[] = attrs.routeStops ?? []
            const o = byName.get(stops[0]) ?? byName.get(l.city)
            const d = byName.get(stops[stops.length - 1])
            if (o && d && !o._id.equals(d._id)) pairs.add(`${o._id}|${d._id}`)
         }
      }
      for (const pair of pairs) {
         const [origin, destination] = pair.split('|')
         const existing = await ServicedRoute.findOne({ vertical, origin, destination })
         if (existing) continue
         await ServicedRoute.create({ vertical, origin, destination, isActive: true })
         routes++
      }
   }
   console.log(`routes   : ${routes} created`)

   const active = await Location.countDocuments({ isActive: true })
   console.log(`\n${active} active locations, ${await ServicedRoute.countDocuments()} routes`)
   await mongoose.disconnect()
}

main().catch((e) => {
   console.error(e.message)
   process.exit(1)
})
