/**
 * Self-check for what a partner may carry onto the homepage: a logo from our
 * own storage and a link a browser opens as a page — nothing else.
 *
 *   npm run check:partners
 *
 * No framework, no database and no server: pure functions only.
 */
import assert from 'assert'

import { checkPartner } from '../controllers/admin/partnerController'
import { presentPublicPartners } from '../dto/public/partner.dto'

// The bucket's address, as production names it; the server's own disk counts too.
process.env.STORAGE_PUBLIC_URL = 'https://bucket.example.com'
delete process.env.STORAGE_PUBLIC_URL_PREVIOUS

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

/** The body as the check leaves it, or the status it refuses it with. */
const run = (body: Record<string, unknown>) => {
   try {
      checkPartner(body)
      return body
   } catch (err: any) {
      return err.statusCode ?? 'thrown without a status'
   }
}

const UUID = '0b4f8a52-6f0e-4c1a-9a43-3f1d2c9e7b10'

console.log('\nPartner checks\n')

check('a logo is a file the partners upload stored, nowhere else', () => {
   for (const ok of [
      `https://bucket.example.com/partners/${UUID}.png`,
      `https://bucket.example.com/public/partners/${UUID}.webp`,
      `/uploads/partners/${UUID}.jpg`,
   ]) {
      assert.deepStrictEqual(run({ logo: ok }), { logo: ok }, ok)
   }
   for (const bad of [
      '',
      `https://elsewhere.example.com/partners/${UUID}.png`,
      `https://bucket.example.com/site/${UUID}.png`,
      `https://bucket.example.com/partners/logo.png`,
      `https://bucket.example.com/partners/${UUID}.png"onerror="x`,
      `https://bucket.example.com/partners/../private/documents/${UUID}.pdf`,
      42,
   ]) {
      assert.strictEqual(run({ logo: bad }), 400, String(bad))
   }
})

check('a website is http(s) or blank', () => {
   assert.deepStrictEqual(run({ website: '  https://acme.cd/fr ' }), { website: 'https://acme.cd/fr' })
   assert.deepStrictEqual(run({ website: 'http://acme.cd' }), { website: 'http://acme.cd' })
   assert.deepStrictEqual(run({ website: '' }), { website: '' })
   assert.deepStrictEqual(run({ website: null }), { website: '' })
   // The last three open in a browser but fail the public list's check: refused, not saved and dropped.
   for (const bad of ['javascript:alert(1)', 'acme.cd', 'ftp://acme.cd', 'tel:+243810000000', 'https://', 7, 'https:/acme.cd', 'http:acme.cd', 'https:\\\\acme.cd']) {
      assert.strictEqual(run({ website: bad }), 400, String(bad))
   }
   assert.strictEqual(run({ website: `https://acme.cd/${'a'.repeat(500)}` }), 400)
})

check('a name is required, trimmed, at most 120 characters', () => {
   assert.deepStrictEqual(run({ name: '  Congo Airways ' }), { name: 'Congo Airways' })
   assert.strictEqual(run({ name: '   ' }), 400)
   assert.strictEqual(run({ name: 12 }), 400)
   assert.strictEqual(run({ name: 'x'.repeat(121) }), 400)
   assert.deepStrictEqual(run({ name: 'x'.repeat(120) }), { name: 'x'.repeat(120) })
})

check('the order is a number; a blank box is refused, not read as 0', () => {
   assert.deepStrictEqual(run({ sortOrder: '3' }), { sortOrder: 3 })
   assert.deepStrictEqual(run({ sortOrder: -1 }), { sortOrder: -1 })
   assert.strictEqual(run({ sortOrder: '' }), 400)
   assert.strictEqual(run({ sortOrder: 'first' }), 400)
})

check('the public list carries name, logo and a real link — not the order or the switch', () => {
   const partner = (website: string) =>
      ({
         _id: { toString: () => 'p1' },
         name: 'Acme',
         logo: `/uploads/partners/${UUID}.png`,
         website,
         sortOrder: 2,
         isActive: true,
      }) as any
   assert.deepStrictEqual(presentPublicPartners([partner('https://acme.cd')]), [
      { id: 'p1', name: 'Acme', logo: `/uploads/partners/${UUID}.png`, website: 'https://acme.cd' },
   ])
   // Blank, or anything but a web page, is no link at all.
   for (const w of ['', 'javascript:alert(1)']) {
      assert.deepStrictEqual(Object.keys(presentPublicPartners([partner(w)])[0]!), ['id', 'name', 'logo'])
   }
})

console.log(failures === 0 ? '\nAll partner checks passed.\n' : `\n${failures} partner check(s) FAILED.\n`)

process.exit(failures === 0 ? 0 : 1)
