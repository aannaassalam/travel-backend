/**
 * Self-check for the catalogue input rules that decide what lands in the
 * database: the map pin and the office list.
 *
 *   npm run check:catalogue
 *
 * No framework, no database and no server — these are pure functions, and a
 * malformed pin or two primary offices must be refused here, not discovered on
 * the public map.
 */
import assert from 'assert'

import { parseOffices } from '../controllers/admin/opsController'
import { geoPoint, parseGeo } from '../model/shared.schema'

let failures = 0
const check = (name: string, fn: () => void) => {
   try {
      fn()
      console.log(`  ✓ ${name}`)
   } catch (err: any) {
      failures += 1
      console.error(`  ✗ ${name}\n      ${err.message}`)
   }
}

/** The status the API would answer with, or null when the input is accepted. */
const refused = (fn: () => unknown) => {
   try {
      fn()
   } catch (err: any) {
      return err.statusCode ?? 'thrown without a status'
   }
   return null
}

console.log('\nCatalogue input checks\n')

console.log('Map pin')
check('absent leaves the pin alone, null clears it', () => {
   assert.strictEqual(parseGeo(undefined), undefined)
   assert.strictEqual(parseGeo(null), null)
})

check('a valid pin comes back as exactly { lat, lng }', () => {
   assert.deepStrictEqual(parseGeo({ lat: -4.3217, lng: 15.3125 }), { lat: -4.3217, lng: 15.3125 })
   assert.deepStrictEqual(parseGeo({ lat: 0, lng: 0 }), { lat: 0, lng: 0 })
   assert.deepStrictEqual(parseGeo({ lat: -90, lng: 180 }), { lat: -90, lng: 180 })
   assert.deepStrictEqual(parseGeo({ lat: 90, lng: -180 }), { lat: 90, lng: -180 })
})

check('anything that is not two in-range numbers is a 400', () => {
   const bad: unknown[] = [
      '-4.32,15.31',
      42,
      true,
      [-4.32, 15.31],
      {},
      { lat: -4.32 },
      { lat: '-4.32', lng: 15.31 },
      { lat: NaN, lng: 15.31 },
      { lat: -4.32, lng: Infinity },
      { lat: 91, lng: 0 },
      { lat: -91, lng: 0 },
      { lat: 0, lng: 181 },
      { lat: 0, lng: -181 },
      { lat: -4.32, lng: 15.31, extra: 1 },
      { lat: -4.32, lng: 15.31, _id: 'x' },
   ]
   bad.forEach((g) =>
      assert.strictEqual(refused(() => parseGeo(g)), 400, `${JSON.stringify(g)} should be refused`)
   )
})

check('a pin is presented only when both coordinates are set', () => {
   assert.deepStrictEqual(geoPoint({ lat: 0, lng: 15.31 }), { lat: 0, lng: 15.31 })
   assert.strictEqual(geoPoint(undefined), undefined)
   assert.strictEqual(geoPoint(null), undefined)
   // What a document reads back for an unset nested path.
   assert.strictEqual(geoPoint({}), undefined)
   assert.strictEqual(geoPoint({ lat: -4.32 }), undefined)
})

console.log('\nOffices')
const office = (over: Record<string, unknown> = {}) => ({
   name: 'Siège Kinshasa',
   city: 'Kinshasa',
   streetAddress: '12 avenue de la Justice',
   phone: '+243 81 000 0000',
   whatsapp: '+243 81 000 0000',
   email: 'kinshasa@example.com',
   hours: 'Lun–Ven 8h–17h',
   ...over,
})

check('absent leaves the list alone; the list itself is the only accepted shape', () => {
   assert.strictEqual(parseOffices(undefined), undefined)
   ;[null, 'office', {}, office()].forEach((v) =>
      assert.strictEqual(refused(() => parseOffices(v)), 400, `${JSON.stringify(v)} should be refused`)
   )
   assert.deepStrictEqual(parseOffices([]), [])
})

check('strings are trimmed, blanks allowed, an existing id kept', () => {
   const [o] = parseOffices([
      office({
         id: '507f1f77bcf86cd799439011',
         name: '  Siège Kinshasa ',
         streetAddress: undefined,
         email: '',
         geo: null,
      }),
   ])!
   assert.strictEqual(o.name, 'Siège Kinshasa')
   assert.strictEqual((o as any)._id, '507f1f77bcf86cd799439011')
   assert.strictEqual(o.streetAddress, '')
   assert.strictEqual(o.email, '')
   assert.strictEqual(o.geo, undefined)
   assert.strictEqual(o.isPrimary, true)
   // A made-up id is dropped rather than sent to Mongo to choke on.
   const [n] = parseOffices([office({ id: 'new-row-1' })])!
   assert.ok(!('_id' in n), 'a non-ObjectId id should be dropped')
})

check('name and city are required and capped at 80; other text at 200', () => {
   assert.strictEqual(refused(() => parseOffices([office({ name: '' })])), 400)
   assert.strictEqual(refused(() => parseOffices([office({ name: '   ' })])), 400)
   assert.strictEqual(refused(() => parseOffices([office({ city: undefined })])), 400)
   assert.strictEqual(refused(() => parseOffices([office({ name: 'x'.repeat(81) })])), 400)
   assert.strictEqual(refused(() => parseOffices([office({ city: 'x'.repeat(81) })])), 400)
   assert.strictEqual(refused(() => parseOffices([office({ hours: 'x'.repeat(201) })])), 400)
   assert.strictEqual(refused(() => parseOffices([office({ phone: 243810000000 })])), 400)
   assert.strictEqual(refused(() => parseOffices([office({ name: { $gt: '' } })])), 400)
   assert.strictEqual(refused(() => parseOffices([office({ geo: { lat: 'x', lng: 1 } })])), 400)
   assert.strictEqual(refused(() => parseOffices(['Kinshasa'])), 400)
   assert.strictEqual(parseOffices([office({ name: 'x'.repeat(80), hours: 'y'.repeat(200) })])!.length, 1)
})

check('at most 20 offices', () => {
   assert.strictEqual(parseOffices(Array.from({ length: 20 }, () => office()))!.length, 20)
   assert.strictEqual(refused(() => parseOffices(Array.from({ length: 21 }, () => office()))), 400)
})

check('exactly one primary office', () => {
   const flags = (list: unknown[]) => parseOffices(list)!.map((o) => o.isPrimary)
   // None marked: the first one is.
   assert.deepStrictEqual(flags([office(), office({ city: 'Goma' })]), [true, false])
   // One marked: kept where it is.
   assert.deepStrictEqual(
      flags([office(), office({ city: 'Goma', isPrimary: true }), office({ city: 'Lubumbashi' })]),
      [false, true, false]
   )
   // Several marked: only the first marked one survives.
   assert.deepStrictEqual(
      flags([office({ isPrimary: false }), office({ isPrimary: true }), office({ isPrimary: true })]),
      [false, true, false]
   )
   // Only a real boolean true counts as marked.
   assert.deepStrictEqual(flags([office(), office({ isPrimary: 'true' })]), [true, false])
})

check('a pin on an office follows the same rule', () => {
   const [o] = parseOffices([office({ geo: { lat: -1.6777, lng: 29.2285 } })])!
   assert.deepStrictEqual(o.geo, { lat: -1.6777, lng: 29.2285 })
})

console.log(
   failures === 0
      ? '\nAll catalogue checks passed.\n'
      : `\n${failures} catalogue check(s) FAILED.\n`
)

process.exit(failures === 0 ? 0 : 1)
