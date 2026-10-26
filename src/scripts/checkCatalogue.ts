/**
 * Self-check for the catalogue input rules that decide what lands in the
 * database: the map pin, the office list, prices and exchange rates.
 *
 *   npm run check:catalogue
 *
 * No framework, no database and no server — these are pure functions, and a
 * malformed pin or two primary offices must be refused here, not discovered on
 * the public map.
 */
import assert from 'assert'

import { readCell } from '../controllers/admin/inventoryCsvController'
import { parseOffices, parseRates } from '../controllers/admin/opsController'
import { geoPoint, parseGeo, parseMoney } from '../model/shared.schema'
import { francRateProblem } from '../services/fx.service'

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

console.log('\nPrices and exchange rates')
check('a price is whole francs; a blank box is "not set", never 0', () => {
   assert.deepStrictEqual(parseMoney({ CDF: '513000' }), { CDF: 513_000 })
   assert.deepStrictEqual(parseMoney({ CDF: 12.6 }), { CDF: 13 })
   assert.deepStrictEqual(parseMoney(513_000), { CDF: 513_000 })
   assert.deepStrictEqual(parseMoney({ CDF: 513_000, USD: 18_000 }), { CDF: 513_000 }) // worked out, never typed
   assert.deepStrictEqual(parseMoney({ CDF: '' }), {})
   assert.deepStrictEqual(parseMoney({}), {})
   assert.strictEqual(parseMoney(undefined), undefined)
})

check('a dollar price from a panel opened before francs is refused, not read as blank', () => {
   assert.strictEqual(refused(() => parseMoney({ USD: 18_000 })), 400)
   assert.strictEqual(refused(() => parseMoney({ USD: '180', CDF: '' })), 400)
})

check('a spreadsheet price is whole francs; a dollar figure in the column is refused', () => {
   const cell = (raw: string, decimalComma = false) =>
      readCell({ key: 'sell_price_cdf', kind: 'money', min: 0 } as any, raw, { decimalComma, slashOrder: 'DMY' })
   assert.deepStrictEqual(cell('513000'), { value: 513_000 })
   assert.deepStrictEqual(cell('513 000'), { value: 513_000 })
   assert.deepStrictEqual(cell('513,000'), { value: 513_000 })
   // How the export wrote $180 while prices were dollars, in both kinds of file.
   assert.ok(cell('180.00').error)
   assert.ok(cell('180,00', true).error)
   assert.ok(cell('45.50').error)
   assert.ok(/thousands/.test(cell('513.000').error ?? ''))
})

check('rates are francs per 1 USD and per 1 EUR, as typed', () => {
   assert.deepStrictEqual(parseRates({ USD: '2850', EUR: 3100 }, {}, 40, false), { USD: 2850, EUR: 3100 })
   // Blank stops offering a currency; absent keeps what is there.
   assert.deepStrictEqual(parseRates({ EUR: '' }, { USD: 2850, EUR: 3100 }, 40, false), { USD: 2850, EUR: undefined })
   assert.strictEqual(refused(() => parseRates({ USD: 0 }, {}, 40, false)), 400)
   assert.strictEqual(refused(() => parseRates({ USD: 'abc' }, {}, 40, false)), 400)
   // Dollars per franc, the figure typed on 2026-10-26: refused, naming the rate it stands for.
   assert.strictEqual(refused(() => parseRates({ USD: 0.00043 }, {}, 40, false)), 400)
   assert.ok(/1 USD = 2,326 FC/.test(francRateProblem('USD', 0.00043) ?? ''))
   assert.strictEqual(refused(() => parseRates({ EUR: 250_000 }, {}, 40, false)), 400)
   assert.strictEqual(francRateProblem('USD', 100) ?? francRateProblem('EUR', 100_000), null)
   // The shape from before francs (francs per dollar under CDF) is not saved over the new one.
   assert.strictEqual(refused(() => parseRates({ CDF: 2850, EUR: 0.92 }, {}, 40, false)), 400)
})

check('a big rate move asks first, naming every currency in one question', () => {
   let err: any
   try {
      parseRates({ USD: 285, EUR: 6200 }, { USD: 2850, EUR: 3100 }, 40, false)
   } catch (e) {
      err = e
   }
   assert.strictEqual(err?.statusCode, 409)
   assert.strictEqual(err?.code, 'RATE_CHANGE_CONFIRM')
   assert.ok(/1 USD = 285 FC/.test(err.message) && /1 EUR = 6,200 FC/.test(err.message), err?.message)
   assert.deepStrictEqual(parseRates({ USD: 285 }, { USD: 2850 }, 40, true), { USD: 285, EUR: undefined })
   // Within the guard, or with nothing to compare against: saved as typed.
   assert.deepStrictEqual(parseRates({ USD: 2900 }, { USD: 2850 }, 40, false), { USD: 2900, EUR: undefined })
   assert.deepStrictEqual(parseRates({ USD: 2850 }, { EUR: 3100 }, 40, false), { USD: 2850, EUR: 3100 })
})

console.log(
   failures === 0
      ? '\nAll catalogue checks passed.\n'
      : `\n${failures} catalogue check(s) FAILED.\n`
)

process.exit(failures === 0 ? 0 : 1)
