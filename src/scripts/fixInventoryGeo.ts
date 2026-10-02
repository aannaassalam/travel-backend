/**
 * Repoints existing hotel coordinates at the city each hotel claims.
 *
 *   npm run fix:geo --            # report only
 *   npm run fix:geo -- --apply    # write
 */
import mongoose from 'mongoose'; import 'dotenv/config'
import { buildMongoUri } from '../config/db.config'

const CENTRES: Record<string, { lat: number; lng: number }> = {
  Kinshasa: { lat: -4.4419, lng: 15.2663 }, Lubumbashi: { lat: -11.6876, lng: 27.5026 },
  Goma: { lat: -1.6585, lng: 29.2206 }, Bukavu: { lat: -2.5083, lng: 28.8608 },
  Matadi: { lat: -5.8167, lng: 13.45 }, Kisangani: { lat: 0.5153, lng: 25.19 },
  'Mbuji-Mayi': { lat: -6.136, lng: 23.5898 }, Kananga: { lat: -5.896, lng: 22.4166 },
  Kolwezi: { lat: -10.7147, lng: 25.4667 }, Mbandaka: { lat: 0.0487, lng: 18.2603 },
}
const km = (a: any, b: any) => {
  const R = 6371, d = (x: number) => (x * Math.PI) / 180
  const dLat = d(b.lat - a.lat), dLng = d(b.lng - a.lng)
  const h = Math.sin(dLat/2)**2 + Math.cos(d(a.lat))*Math.cos(d(b.lat))*Math.sin(dLng/2)**2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}
const apply = process.argv.includes('--apply')
;(async () => {
  await mongoose.connect(buildMongoUri())
  const db = mongoose.connection.db!
  let moved = 0
  for (const col of ['hotels', 'restaurants']) {
    const docs = await db.collection(col).find({}, { projection: { name:1, city:1, geo:1 } }).toArray() as any[]
    for (const d of docs) {
      const c = CENTRES[d.city]
      if (!c) { console.log(`  ${col.padEnd(11)} ${String(d.city).padEnd(12)} unknown city — add it to CENTRES`); continue }
      const off = d.geo ? km(d.geo, c) : null
      if (off !== null && off <= 25) continue          // already sensible
      const j = () => (Math.random() - 0.5) * 0.055
      const geo = { lat: +(c.lat + j()).toFixed(6), lng: +(c.lng + j()).toFixed(6) }
      moved++
      console.log(`  ${col.padEnd(11)} ${String(d.city).padEnd(12)} ${off === null ? 'no geo' : off + ' km away'} -> city centre`)
      if (apply) await db.collection(col).updateOne({ _id: d._id }, { $set: { geo } })
    }
  }
  console.log(moved === 0 ? '\nAll coordinates already sit in their city.'
    : apply ? `\nRepointed ${moved} record(s).` : `\n${moved} record(s) would move. Re-run with --apply.`)
  await mongoose.disconnect()
})().catch(e => { console.error(e); process.exit(1) })
