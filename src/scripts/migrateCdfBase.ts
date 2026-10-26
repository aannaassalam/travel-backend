/**
 * Prices became Congolese francs on 2026-10-24. This converts, once, a database
 * written while they were US dollars.
 *
 *   npm run migrate:cdf                                  # dry run: what would change
 *   npm run migrate:cdf -- --rate=2850 --apply           # write
 *   npm run migrate:cdf -- --rate=2850 --eur=3100 --apply
 *   npx ts-node --transpile-only src/scripts/migrateCdfBase.ts   # the pure self-check: no database
 *
 * --rate=<francs per 1 USD>   Without it: the old Settings rate (exchangeRates.CDF),
 *                             while Settings are still in the old shape. Without
 *                             either, refused. So is any rate (this one or the
 *                             euro's) outside 100–100 000 FC: 0.00043, dollars
 *                             per franc, priced everything at 0 FC on 2026-10-26.
 * --eur=<francs per 1 EUR>    Optional. Without it: --rate ÷ the old Settings euro
 *                             rate (euros per dollar), when there is one.
 * --backup-dir=<dir>          Default ../travel-db-backups/<YYYY-MM-DD>-cdf-base/
 *                             beside this repo.
 *
 * Only what is still in dollars changes, so a second run changes nothing:
 *
 *  - Every price with a USD figure becomes { CDF } — the franc figure customers
 *    see today: USD × rate, rounded up to the next 100 FC — and the legacy USD
 *    and EUR keys go. Listings (all twelve price fields), room types, the legacy
 *    rate calendar, dishes, and restaurant delivery zones (fee, minimum order).
 *  - Plain amounts in USD cents become francs the same way: a car's deposit and
 *    an activity's child price (on a listing whose sell price is still in
 *    dollars, so only once), and an enquiry's quote (then marked
 *    quotedCurrency: 'CDF').
 *  - Orders without baseCurrency 'CDF': every USD amount × the order's own
 *    francs per USD, rounded to the franc (history, not prices: no rounding up).
 *    A CDF order's total becomes its chargedTotal exactly. fxRate becomes francs
 *    per 1 unit of the charged currency and baseCurrency becomes 'CDF'.
 *    chargedTotal, chargedCurrency, the provider's payment data and `currency`
 *    (the base the order was made in, 'USD': nothing reads it as total's) are
 *    not touched.
 *  - Settings: exchangeRates { CDF, EUR (euros per dollar) } → { USD, EUR } in
 *    francs, baseCurrency 'CDF'. Written last, so a run that stops halfway can
 *    still find the old rate the next time.
 *
 * A francs per euro worked out here is kept to the centime, as the office types it.
 *
 * Before writing, every document about to change (only those) is saved as
 * canonical EJSON, one file per collection, in the backup folder. To put one
 * back: mongoimport --uri=… --collection=listings --mode=upsert --jsonArray --file=listings.json
 * A document changed while this runs is left for the next run. Every other
 * converted record gets a new version, so a panel opened before the run is
 * told to reload instead of saving its old boxes over the francs.
 * The run is written to the audit log with its counts and rates. The backup
 * holds customers' personal data: delete it once the run has been checked.
 */
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import AuditLog from '../model/auditLogModel'
import { Enquiry } from '../model/enquiryModel'
import { RatePlan, RoomType } from '../model/hotelModel'
import { Listing } from '../model/listingModel'
import { Order } from '../model/orderModel'
import { MenuItem, Restaurant } from '../model/restaurantModel'
import SettingsModel from '../model/settingsModel'
import { francRateProblem, francsPerEuro } from '../services/fx.service'

/* ------------------------------------------------------------ pure helpers */

/**
 * USD cents → whole francs, rounded up to the next 100 FC: exactly what the
 * site showed in francs while prices were dollars (the old fx.service). The
 * seeds price with it too.
 */
export const usdToFrancs = (cents: number, rate: number) =>
   Math.ceil(Math.round((cents / 100) * rate) / 100) * 100

/**
 * A price still in dollars: it has a USD figure, or is a bare number of cents
 * (from before prices had currencies).
 *
 * The code since 2026-10-24 writes a price whole, as francs only, so a CDF
 * beside a USD figure is either the 0 a save filled in before this ran or a
 * franc price typed before conversion existed — which customers have not seen
 * since. The dollar figure is what they see today, so it is the one converted.
 */
export const inDollars = (v: any) => typeof v === 'number' || typeof v?.USD === 'number'

/** A dollar price as a franc one; the legacy keys go with it. */
export const francsPrice = (v: any, rate: number) => ({
   CDF: usdToFrancs(typeof v === 'number' ? v : v.USD, rate),
})

type Change = Record<string, any> | null
const orNull = (set: Record<string, any>): Change => (Object.keys(set).length ? set : null)

const PRICES = ['costPrice', 'sellPrice']
const LISTING_PRICES = [
   ...PRICES,
   'childCostPrice',
   'childSellPrice',
   'infantCostPrice',
   'infantSellPrice',
   'hourlyCostPrice',
   'hourlySellPrice',
   'sixHourCostPrice',
   'sixHourSellPrice',
   'twelveHourCostPrice',
   'twelveHourSellPrice',
]

/** The $set that brings these prices to francs, or null when none is in dollars. */
export const pricesToFrancs = (doc: any, fields: string[], rate: number): Change => {
   const set: Record<string, any> = {}
   for (const f of fields) if (inDollars(doc[f])) set[f] = francsPrice(doc[f], rate)
   return orNull(set)
}

/**
 * A listing: its prices and, while its sell price is still in dollars, the
 * plain amounts in cents among its attributes. The sell price is the one every
 * listing has and every save sends, so once it is francs the attributes are too.
 */
export const listingToFrancs = (doc: any, rate: number): Change => {
   const set = pricesToFrancs(doc, LISTING_PRICES, rate) ?? {}
   if (inDollars(doc.sellPrice)) {
      for (const a of ['deposit', 'childPrice']) {
         const v = doc.attributes?.[a]
         if (typeof v === 'number') set[`attributes.${a}`] = usdToFrancs(v, rate)
      }
   }
   return orNull(set)
}

/** A restaurant's delivery zones, each fee and minimum order still in dollars. */
export const zonesToFrancs = (doc: any, rate: number): Change => {
   const zones: any[] = doc.deliveryZones ?? []
   if (!zones.some((z) => inDollars(z.fee) || inDollars(z.minOrder))) return null
   return {
      deliveryZones: zones.map((z) => ({
         ...z,
         ...(inDollars(z.fee) ? { fee: francsPrice(z.fee, rate) } : {}),
         ...(inDollars(z.minOrder) ? { minOrder: francsPrice(z.minOrder, rate) } : {}),
      })),
   }
}

/** A quote in USD cents (one with no quotedCurrency) in francs, marked so. */
export const enquiryToFrancs = (doc: any, rate: number): Change =>
   typeof doc.quotedAmount === 'number' && !doc.quotedCurrency
      ? { quotedAmount: usdToFrancs(doc.quotedAmount, rate), quotedCurrency: 'CDF' }
      : null

/**
 * Francs per USD an order was charged at. A CDF order has its own: its fxRate
 * — which until 2026-10-22 was chargedTotal ÷ total, francs per US cent (about
 * 28), so one under 100 is read as that. Any other order: today's rate.
 */
export const orderFrancsPerUsd = (o: any, rate: number) => {
   const fx = Number(o.fxRate)
   if (o.chargedCurrency !== 'CDF' || !(fx > 0)) return rate
   return fx >= 100 ? fx : fx * 100
}

const ORDER_LINE_AMOUNTS = ['unitSellPrice', 'unitCostPrice', 'lineTotal', 'lineCost']

/** An order whose amounts are still USD cents, in francs. See the header for the rules. */
export const orderToFrancs = (o: any, rate: number): Change => {
   if (o.baseCurrency === 'CDF') return null
   const perUsd = orderFrancsPerUsd(o, rate)
   // Multiplied first: 523.43 × 2850 is 1 491 775.4999… in floating point.
   const fr = (cents: number) => Math.round((cents * perUsd) / 100)
   const fx = Number(o.fxRate)
   const charged = o.chargedCurrency
   const set: Record<string, any> = {
      total:
         charged === 'CDF' && typeof o.chargedTotal === 'number'
            ? o.chargedTotal
            : fr(Number(o.total) || 0),
      items: (o.items ?? []).map((i: any) => {
         const line = { ...i }
         for (const k of ORDER_LINE_AMOUNTS) if (typeof line[k] === 'number') line[k] = fr(line[k])
         return line
      }),
      // Francs per 1 unit of what was charged: 1 for francs, the dollar rate
      // used, and for euros that rate ÷ the order's own euros per dollar.
      fxRate: charged === 'CDF' ? 1 : charged === 'EUR' && fx > 0 ? francsPerEuro(rate, fx) : rate,
      baseCurrency: 'CDF',
   }
   if (typeof o.delivery?.fee === 'number') set['delivery.fee'] = fr(o.delivery.fee)
   return set
}

/** Settings rates as they were while prices were dollars: { CDF: francs per dollar, EUR: euros per dollar }. */
export const isOldRates = (r: any) => Boolean(r) && typeof r === 'object' && 'CDF' in r

export const settingsToFrancs = (s: any, rate: number | undefined, eur?: number): Change => {
   // None yet: getSettings() makes them in francs.
   if (!s) return null
   const set: Record<string, any> = {}
   if (isOldRates(s?.exchangeRates)) set.exchangeRates = { USD: rate, ...(eur ? { EUR: eur } : {}) }
   if (s?.baseCurrency !== 'CDF') set.baseCurrency = 'CDF'
   return orNull(set)
}

/* ------------------------------------------------------------------- run */

const arg = (name: string) => {
   const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
   return hit === undefined ? undefined : hit.slice(name.length + 3)
}

const francsArg = (name: string) => {
   const raw = arg(name)
   if (raw === undefined) return undefined
   const n = Number(raw)
   if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--${name} must be a positive number of francs, like --${name}=2850`)
   }
   return n
}

/** "Still in dollars", as a query: a USD figure on any of these prices, or a bare number. */
const dollarsIn = (fields: string[]) => ({
   $or: fields.flatMap((f) => [{ [`${f}.USD`]: { $type: 'number' } }, { [f]: { $type: 'number' } }]),
})

const TARGETS: { model: any; filter: object; convert: (doc: any, rate: number) => Change }[] = [
   { model: Listing, filter: dollarsIn(LISTING_PRICES), convert: listingToFrancs },
   { model: RoomType, filter: dollarsIn(PRICES), convert: (d, r) => pricesToFrancs(d, PRICES, r) },
   { model: RatePlan, filter: dollarsIn(PRICES), convert: (d, r) => pricesToFrancs(d, PRICES, r) },
   { model: MenuItem, filter: dollarsIn(PRICES), convert: (d, r) => pricesToFrancs(d, PRICES, r) },
   {
      model: Restaurant,
      filter: dollarsIn(['deliveryZones.fee', 'deliveryZones.minOrder']),
      convert: zonesToFrancs,
   },
   {
      model: Enquiry,
      filter: { quotedAmount: { $type: 'number' }, quotedCurrency: { $exists: false } },
      convert: enquiryToFrancs,
   },
   { model: Order, filter: { baseCurrency: { $ne: 'CDF' } }, convert: orderToFrancs },
]

const short = (v: unknown) => {
   const s = JSON.stringify(v)
   return s.length > 240 ? `${s.slice(0, 240)}…` : s
}

const fc = (n: number) => `${n.toLocaleString('en-GB')} FC`

/** A dry-run line a person checks at a glance: "Kinshasa → Matadi, Socogetra: $28 → 64,400 FC". */
const example = (before: any, set: Record<string, any>) => {
   const name = before.title ?? before.name ?? before.reference
   const label =
      (typeof name === 'object' ? (name?.fr ?? name?.en) : name) ??
      (before.date ? `night of ${new Date(before.date).toISOString().slice(0, 10)}` : String(before._id))
   const was = set.sellPrice ? before.sellPrice : set.quotedAmount !== undefined ? before.quotedAmount : undefined
   if (was === undefined) return `${label}: ${short(set)}`
   const cents = typeof was === 'number' ? was : was.USD
   return `${label}: $${(cents / 100).toLocaleString('en-GB')} → ${fc(set.sellPrice?.CDF ?? set.quotedAmount)}`
}

/** One file per collection, never over an earlier backup. */
const backUp = (dir: string, name: string, docs: any[]) => {
   const body = mongoose.mongo.BSON.EJSON.stringify(docs, undefined, 1, { relaxed: false })
   let file = path.join(dir, `${name}.json`)
   if (fs.existsSync(file)) file = path.join(dir, `${name}-${Date.now()}.json`)
   fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 })
   return file
}

const run = async () => {
   // A slip must not quietly convert at the old Settings rate: `--rate 2900`
   // (no =), or `npm run migrate:cdf --rate=2900` (no --, so npm keeps it).
   const unknown = process.argv.slice(2).filter((a) => !/^--(migrate|apply|(rate|eur|backup-dir)=.+)$/.test(a))
   const kept = ['rate', 'eur', 'apply', 'backup_dir'].filter((k) => process.env[`npm_config_${k}`] !== undefined)
   if (unknown.length || kept.length) {
      throw new Error(
         `Not understood: ${[...unknown, ...kept.map((k) => `--${k.replace('_', '-')} before the --`)].join(', ')}. ` +
            'Use: npm run migrate:cdf -- --rate=<francs per USD> [--eur=<francs per EUR>] [--backup-dir=<dir>] [--apply]'
      )
   }
   const apply = process.argv.includes('--apply')
   const rateArg = francsArg('rate')
   const eurArg = francsArg('eur')

   await mongoose.connect(buildMongoUri())
   const { host, name } = mongoose.connection
   console.log(`Database "${name}" on ${host} — ${apply ? 'APPLY' : 'DRY RUN, nothing is written (add --apply)'}\n`)

   const settings = await SettingsModel.collection.findOne({})
   const old = isOldRates(settings?.exchangeRates) ? (settings as any).exchangeRates : undefined
   const oldRate = Number(old?.CDF) > 0 ? Number(old.CDF) : undefined
   const rate = rateArg ?? oldRate
   // Only Settings in the old shape take a euro rate from here.
   const eur = !old ? undefined : (eurArg ?? (rate && Number(old.EUR) > 0 ? francsPerEuro(rate, Number(old.EUR)) : undefined))

   // What is still in dollars, collection by collection. Needs no rate.
   const found = await Promise.all(
      TARGETS.map(async (t) => ({ t, docs: await t.model.collection.find(t.filter).toArray() }))
   )
   for (const { t, docs } of found) {
      console.log(`  ${t.model.collection.collectionName}: ${docs.length} to convert`)
   }
   const settingsPending = Boolean(settingsToFrancs(settings, rate, eur))
   console.log(
      `  settings: ${!settings ? 'none yet' : settingsPending ? (old ? 'rates and base to convert' : 'base to set to CDF') : 'already in francs'}`
   )

   const needsRate = found.some((f) => f.docs.length) || Boolean(old)
   if (!found.some((f) => f.docs.length) && !settingsPending) {
      console.log('\nNothing to migrate — everything is already in francs.')
      return
   }
   if (needsRate && !rate) {
      const typed = Number(settings?.exchangeRates?.USD) > 0 ? ` (Settings say 1 USD = ${settings.exchangeRates.USD} FC)` : ''
      throw new Error(`No rate: pass --rate=<francs per 1 USD>${typed}. Settings no longer hold the old dollar rate.`)
   }
   // Before any example is shown: a dry run at such a rate is no check at all.
   for (const [c, v, from] of [
      ['USD', rate, rateArg ? '--rate' : 'the old Settings'],
      ['EUR', eur, eurArg ? '--eur' : 'the old Settings'],
   ] as const) {
      const problem = v === undefined ? null : francRateProblem(c, v)
      if (problem) throw new Error(`Refused, nothing was written. ${problem} (from ${from})`)
   }
   if (rate) {
      const from = rateArg ? `--rate${oldRate && oldRate !== rateArg ? ` (the old Settings said ${oldRate})` : ''}` : 'the old Settings'
      // The euro rate only goes into Settings: a euro order keeps its own.
      const euro = old ? `; Settings get ${eur ? `1 EUR = ${eur} FC` : 'no EUR rate'}` : ''
      console.log(`\n1 USD = ${rate} FC, from ${from}${euro}`)
      console.log(`Check: ${[100, 2800, 10_000].map((c) => `$${c / 100} → ${fc(usdToFrancs(c, rate))}`).join(', ')}`)
   }
   if (eurArg && !old) console.log('--eur is not used: Settings already hold rates in francs.')

   const plans = found.map(({ t, docs }) => ({
      t,
      rows: docs.map((before: any) => ({ before, set: t.convert(before, rate!) })).filter((r: any) => r.set),
   }))
   for (const { t, rows } of plans) {
      for (const r of rows.slice(0, 3)) {
         console.log(`  e.g. ${t.model.collection.collectionName}: ${example(r.before, r.set)}`)
      }
   }
   const settingsSet = settingsToFrancs(settings, rate, eur)
   if (settingsSet) console.log(`  e.g. settings/${settings!._id}: ${short(settingsSet)}`)

   if (!apply) {
      console.log('\nDry run — re-run with --apply to write (a backup is taken first).')
      return
   }

   // --- backup, then write --------------------------------------------------
   const dir =
      arg('backup-dir') ??
      path.resolve(__dirname, '../../..', 'travel-db-backups', `${new Date().toISOString().slice(0, 10)}-cdf-base`)
   // Orders and enquiries carry customers' names and phones: for this user only.
   fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
   for (const { t, rows } of plans) {
      if (rows.length) backUp(dir, t.model.collection.collectionName, rows.map((r: any) => r.before))
   }
   if (settingsSet) backUp(dir, SettingsModel.collection.collectionName, [settings])
   console.log(`\nBackup of every document about to change: ${dir}`)

   // Only the version that was read and backed up is converted: one changed
   // in the meantime (a booking, an edit) is left for the next run.
   const counts: Record<string, number> = {}
   let left = 0
   for (const { t, rows } of plans) {
      if (!rows.length) continue
      const res = await t.model.collection.bulkWrite(
         rows.map((r: any) => ({
            updateOne: {
               filter: { _id: r.before._id, updatedAt: r.before.updatedAt ?? null },
               // A new version makes a panel opened before this run reload
               // (§2.2) rather than save its blank or 0 boxes over the francs.
               // Not orders: a payment callback saving one must not fail for it.
               update: t.model === Order ? { $set: r.set } : { $set: r.set, $inc: { __v: 1 } },
            },
         })),
         { ordered: false }
      )
      counts[t.model.collection.collectionName] = res.modifiedCount
      left += rows.length - res.modifiedCount
   }
   if (settingsSet) {
      // Rates saved in the panel meanwhile are francs already: not written over.
      const res = await SettingsModel.collection.updateOne(
         { _id: settings!._id, updatedAt: settings!.updatedAt ?? null },
         { $set: settingsSet }
      )
      counts.settings = res.modifiedCount
      left += 1 - res.modifiedCount
   }

   await AuditLog.create({
      actorEmail: 'system',
      action: 'CDF_BASE_MIGRATED',
      entityType: 'Migration',
      after: { counts, usdRate: rate, eurRate: eur, rateFrom: rateArg ? '--rate' : 'old settings', backupDir: dir },
      reason: rate ? `Prices converted to francs at 1 USD = ${rate} FC` : 'Base currency set to CDF',
      ip: 'internal',
      userAgent: 'migrate:cdf',
   })

   console.log('\nConverted:')
   for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`)
   if (left) console.log(`\n${left} document(s) changed while this ran and were left as they are: run it again.`)
   console.log('\nDone. Written to the audit log (CDF_BASE_MIGRATED).')
}

/* -------------------------------------------------------------- self-check */

const selfCheck = () => {
   const assert: typeof import('assert') = require('assert')
   const R = 2850

   assert.strictEqual(usdToFrancs(18_000, R), 513_000) // $180 → 513 000 FC
   assert.strictEqual(usdToFrancs(1234, 2800), 34_600) // 34 552 → the next hundred
   assert.strictEqual(usdToFrancs(1050, 2800), 29_400) // float noise does not round up
   assert.strictEqual(usdToFrancs(1, R), 100) // up, never down
   assert.strictEqual(usdToFrancs(0, R), 0)

   assert.ok(inDollars({ USD: 0 }) && inDollars({ USD: 18_000, CDF: 0 }) && inDollars(12_000))
   assert.ok(!inDollars({ CDF: 513_000 }) && !inDollars(undefined) && !inDollars({ USD: null }))
   assert.deepStrictEqual(francsPrice({ USD: 18_000, EUR: 16_560, CDF: 0 }, R), { CDF: 513_000 })

   // A car in dollars: its prices, and its deposit in cents. Then nothing more.
   const car = {
      costPrice: { USD: 12_000 },
      sellPrice: { USD: 18_000, CDF: 0 },
      hourlySellPrice: { USD: 0 },
      attributes: { make: 'Toyota', deposit: 30_000 },
   }
   assert.deepStrictEqual(listingToFrancs(car, R), {
      costPrice: { CDF: 342_000 },
      sellPrice: { CDF: 513_000 },
      hourlySellPrice: { CDF: 0 },
      'attributes.deposit': 855_000,
   })
   assert.strictEqual(
      listingToFrancs({ costPrice: { CDF: 342_000 }, sellPrice: { CDF: 513_000 }, attributes: { deposit: 855_000 } }, R),
      null
   )
   // An activity's child price; and a listing priced before prices had currencies.
   assert.deepStrictEqual(listingToFrancs({ sellPrice: { USD: 7000 }, attributes: { childPrice: 3500 } }, R), {
      sellPrice: { CDF: 199_500 },
      'attributes.childPrice': 99_800,
   })
   assert.deepStrictEqual(listingToFrancs({ sellPrice: 7000 }, R), { sellPrice: { CDF: 199_500 } })
   assert.deepStrictEqual(pricesToFrancs({ sellPrice: { USD: 9000 }, costPrice: { CDF: 1 } }, PRICES, R), {
      sellPrice: { CDF: 256_500 },
   })
   assert.strictEqual(pricesToFrancs({ sellPrice: { CDF: 256_500 } }, PRICES, R), null)

   const zone = { _id: 'z', name: 'Gombe', fee: { USD: 200 }, minOrder: { USD: 1000, CDF: 0 }, isActive: true }
   assert.deepStrictEqual(zonesToFrancs({ deliveryZones: [zone, { _id: 'y', fee: { CDF: 5700 } }] }, R), {
      deliveryZones: [
         { _id: 'z', name: 'Gombe', fee: { CDF: 5700 }, minOrder: { CDF: 28_500 }, isActive: true },
         { _id: 'y', fee: { CDF: 5700 } },
      ],
   })
   assert.strictEqual(zonesToFrancs({ deliveryZones: [{ fee: { CDF: 5700 } }] }, R), null)
   assert.strictEqual(zonesToFrancs({}, R), null)

   assert.deepStrictEqual(enquiryToFrancs({ quotedAmount: 4_500_000 }, R), {
      quotedAmount: 128_250_000,
      quotedCurrency: 'CDF',
   })
   assert.strictEqual(enquiryToFrancs({ quotedAmount: 128_250_000, quotedCurrency: 'CDF' }, R), null)
   assert.strictEqual(enquiryToFrancs({}, R), null)

   // Orders. Paid in dollars: today's rate, to the franc, no rounding up.
   const line = { _id: 'l', vertical: 'CAR', quantity: 1, unitSellPrice: 1050, unitCostPrice: 700, lineTotal: 1050, lineCost: 700 }
   const usdOrder = { chargedCurrency: 'USD', fxRate: 1, total: 1050, chargedTotal: 1050, currency: 'USD', items: [line] }
   assert.deepStrictEqual(orderToFrancs(usdOrder, R), {
      total: 29_925,
      items: [{ ...line, unitSellPrice: 29_925, unitCostPrice: 19_950, lineTotal: 29_925, lineCost: 19_950 }],
      fxRate: R,
      baseCurrency: 'CDF',
   }) // `currency` stays 'USD'
   // Paid in francs at the order's own rate; its total is what was charged.
   const cdfOrder = {
      chargedCurrency: 'CDF',
      fxRate: 2800,
      total: 1050,
      chargedTotal: 29_400,
      items: [line],
      delivery: { fee: 200, feeCharged: 5600 },
   }
   const cdf = orderToFrancs(cdfOrder, R)!
   assert.strictEqual(cdf.total, 29_400)
   assert.deepStrictEqual([cdf.items[0].lineTotal, cdf.items[0].lineCost], [29_400, 19_600])
   assert.strictEqual(cdf['delivery.fee'], 5600)
   assert.strictEqual(cdf.fxRate, 1)
   // Before 2026-10-22 a CDF order's fxRate was francs per cent: 29 400 ÷ 1050 = 28.
   assert.deepStrictEqual(orderToFrancs({ ...cdfOrder, fxRate: 28 }, R), cdf)
   assert.strictEqual(orderFrancsPerUsd({ chargedCurrency: 'CDF', fxRate: 0 }, R), R)
   // Half a franc goes up, whatever floating point makes of $523.43 × 2850.
   assert.strictEqual(orderToFrancs({ chargedCurrency: 'USD', total: 52_343, items: [] }, R)!.total, 1_491_776)
   // Paid in euros: francs per euro from the order's own euros per dollar.
   const eurOrder = orderToFrancs({ chargedCurrency: 'EUR', fxRate: 0.92, total: 10_000, chargedTotal: 9200, items: [] }, R)!
   assert.deepStrictEqual([eurOrder.total, eurOrder.fxRate], [285_000, 3097.83]) // 3 097.826… to the centime
   assert.strictEqual(orderToFrancs({ ...usdOrder, baseCurrency: 'CDF' }, R), null)
   assert.deepStrictEqual(orderToFrancs({ chargedCurrency: 'USD', total: 500, items: [{ quantity: 1, lineTotal: 500 }] }, R)!.items, [
      { quantity: 1, lineTotal: 14_250 },
   ])

   assert.strictEqual(francsPerEuro(R, 0.92), 3097.83)
   // 100–100 000 FC per unit; 0.00043 (dollars per franc) is refused, naming 2 326.
   assert.ok(/1 USD = 2,326 FC/.test(francRateProblem('USD', 0.00043) ?? ''))
   assert.ok(francRateProblem('USD', 99) && francRateProblem('EUR', 100_001) && francRateProblem('USD', 'abc'))
   assert.strictEqual(francRateProblem('USD', 2300) ?? francRateProblem('EUR', 2584.27), null)
   assert.deepStrictEqual(settingsToFrancs({ exchangeRates: { CDF: 2850, EUR: 0.92 }, baseCurrency: 'USD' }, R, 3097.83), {
      exchangeRates: { USD: R, EUR: 3097.83 },
      baseCurrency: 'CDF',
   })
   assert.strictEqual(settingsToFrancs(null, R), null)
   assert.deepStrictEqual(settingsToFrancs({ exchangeRates: { CDF: 2850 }, baseCurrency: 'USD' }, R), {
      exchangeRates: { USD: R },
      baseCurrency: 'CDF',
   })
   assert.strictEqual(settingsToFrancs({ exchangeRates: { USD: R, EUR: 3100 }, baseCurrency: 'CDF' }, R), null)
   assert.deepStrictEqual(settingsToFrancs({ exchangeRates: { USD: R }, baseCurrency: 'USD' }, undefined), {
      baseCurrency: 'CDF',
   })
   console.log('migrateCdfBase self-check: ok')
}

if (require.main === module) {
   // Always first: a broken conversion never reaches a database.
   selfCheck()
   if (!process.argv.includes('--migrate')) {
      console.log(
         'Nothing was read or written. To migrate: npm run migrate:cdf -- [--rate=<francs per USD>] [--apply]'
      )
   } else {
      run()
         .then(() => mongoose.disconnect())
         .catch(async (e) => {
            console.error(`\n${e.message}`)
            await mongoose.disconnect().catch(() => undefined)
            process.exit(1)
         })
   }
}
