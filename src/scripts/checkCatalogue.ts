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

import { Types } from 'mongoose'

import { customerLocale, knownLocale } from '../constants/domain.constants'
import { readCell, writeCell } from '../controllers/admin/inventoryCsvController'
import { presentListing as presentAdminListing } from '../controllers/admin/listingController'
import { parseOffices, parseRates } from '../controllers/admin/opsController'
import { login, updateMe, verifyOtp } from '../controllers/public/customerAuthController'
import { hashOtp, hashPassword } from '../middleware/customerAuth'
import { Customer } from '../model/customerModel.admin'
import { Order } from '../model/orderModel'
import { PhoneVerification } from '../model/phoneVerificationModel'
import { geoPoint, parseFee, parseGeo, parseMoney, resolveLocalized, tagTranslationsOf, toLocalized } from '../model/shared.schema'
import { bestDiscountOf, bestPromoted, discountOf, Listing, PROMO_FIELDS, promoSlotsOf } from '../model/listingModel'
import { Hotel, RoomType } from '../model/hotelModel'
import { MenuItem, Restaurant } from '../model/restaurantModel'
import { Location } from '../model/locationModel'
import { VehicleCategory } from '../model/vehicleCategoryModel'
import { NotificationLog, NotificationTemplate } from '../model/enquiryModel'
import { presentHotel as presentAdminHotel, presentRestaurant as presentAdminRestaurant } from '../dto/admin/inventory.dto'
import { presentHotel, presentListing, presentRestaurant, presentVehicleCards } from '../dto/public/catalogue.dto'
import { presentPublicCategory } from '../dto/public/transfer.dto'
import { presentOrder as presentAdminOrder } from '../dto/admin/order.dto'
import { quoteTransfer } from '../controllers/public/transferController'
import { notify, notifyOrder } from '../services/notifications/notify.service'
import * as smsService from '../services/notifications/sms.service'
import { payPageLanguage } from '../services/payments/maxicash.service'
import { francRateProblem, refreshRates } from '../services/fx.service'
import { applyPromotion } from '../services/promotion.service'
import { asClient } from '../utils/clientContent'
import { createOrder } from '../controllers/public/orderController'
import { markCashReceived, markDocumentsDelivered, transitionOrder } from '../controllers/admin/orderController'
import { orderStage } from '../services/orders/orderStage'
import AuditLog from '../model/auditLogModel'
import { Ride } from '../model/rideModel'
import * as settingsModel from '../model/settingsModel'
import SettingsModel from '../model/settingsModel'
import { SaleVehicle } from '../model/vehicleSaleModel'
import { releaseExpiredCashHolds } from '../services/scheduledJobs.service'
import { vehicleSaleRefusal } from '../services/vehicleSale.service'

let failures = 0
// As the website and today's app read the API (?i18n=1); older app builds are checked on their own below.
const check = (name: string, fn: () => void) => {
   try {
      asClient(true, fn)
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

check('office hours are per language; a plain string is French; each language capped at 200', () => {
   assert.deepStrictEqual(parseOffices([office()])![0].hours, { fr: 'Lun–Ven 8h–17h' })
   const [o] = parseOffices([office({ hours: { fr: ' Lun–Ven ', en: 'Mon–Fri', zh: '', xx: 'dropped' } })])!
   assert.deepStrictEqual(o.hours, { fr: 'Lun–Ven', en: 'Mon–Fri' })
   assert.strictEqual(refused(() => parseOffices([office({ hours: { en: 'x'.repeat(201) } })])), 400)
   assert.strictEqual(refused(() => parseOffices([office({ hours: ['Lun'] })])), 400)
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

check('promotions on rooms and dishes: saved only with a real discount, the best one shown', () => {
   const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
   // A new room or dish: checked against its own sell price.
   const fresh = { sellPrice: { CDF: 80_000 } }
   applyPromotion({ promoCompareAtPrice: { CDF: 100_000 }, promoEndsAt: day(5) }, fresh)
   assert.strictEqual((fresh as any).promoCompareAtPrice.CDF, 100_000)
   assert.strictEqual(refused(() => applyPromotion({ promoCompareAtPrice: { CDF: 80_000 } }, { sellPrice: { CDF: 80_000 } })), 400)
   assert.strictEqual(refused(() => applyPromotion({ promoCompareAtPrice: { CDF: 100_000 }, promoEndsAt: day(-3) }, { sellPrice: { CDF: 80_000 } })), 400)
   // An edit: a sell price raised above the old price is refused; a blank old price clears it all.
   const current = { sellPrice: { CDF: 80_000 }, promoCompareAtPrice: { CDF: 100_000 }, promoEndsAt: null }
   assert.strictEqual(refused(() => applyPromotion({ sellPrice: { CDF: 120_000 } }, { sellPrice: { CDF: 120_000 } }, current)), 400)
   const cleared: Record<string, any> = {}
   applyPromotion({ promoCompareAtPrice: '' }, cleared, current)
   assert.deepStrictEqual([cleared.promoCompareAtPrice, cleared.promoEndsAt], [{ CDF: 0 }, null])
   // The card shows the biggest discount; an ended one does not count.
   const rooms = [
      { name: 'a', sellPrice: { CDF: 90 }, promoCompareAtPrice: { CDF: 100 } },
      { name: 'b', sellPrice: { CDF: 50 }, promoCompareAtPrice: { CDF: 100 }, promoEndsAt: new Date(`${day(-2)}T00:00:00Z`) },
      { name: 'c', sellPrice: { CDF: 70 }, promoCompareAtPrice: { CDF: 100 } },
      { name: 'd', sellPrice: { CDF: 60 } },
   ]
   assert.strictEqual(bestPromoted(rooms)?.name, 'c')
   assert.strictEqual(bestPromoted([rooms[1], rooms[3]]), undefined)
   assert.deepStrictEqual([discountOf(rooms[2]), discountOf(rooms[1]), discountOf(undefined)], [30, 0, 0])
})

console.log('\nA promotion on every price')
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const carSlots = promoSlotsOf('CAR')
const routeSlots = promoSlotsOf('BUS')

check('every price of a car or a route goes on promotion on its own', () => {
   // Only the 6-hour rate; the 24-hour box left blank.
   const six: Record<string, any> = { sellPrice: { CDF: 513_000 }, sixHourSellPrice: { CDF: 171_000 } }
   const body = { promoCompareAtPrice: {}, sixHourPromoCompareAtPrice: { CDF: 200_000 }, promoEndsAt: inDays(5) }
   applyPromotion(body, six, null, carSlots)
   assert.deepStrictEqual([six.promoCompareAtPrice, six.sixHourPromoCompareAtPrice], [{ CDF: 0 }, { CDF: 200_000 }])
   assert.strictEqual(six.promoEndsAt.toISOString().slice(0, 10), inDays(5))
   // Only the child fare.
   const child: Record<string, any> = { sellPrice: { CDF: 42_800 }, childSellPrice: { CDF: 28_500 } }
   applyPromotion({ childPromoCompareAtPrice: { CDF: 35_000 } }, child, null, routeSlots)
   assert.deepStrictEqual(child.childPromoCompareAtPrice, { CDF: 35_000 })
   // A free baby fare has nothing to take off.
   const free = { sellPrice: { CDF: 42_800 }, infantSellPrice: { CDF: 0 } }
   assert.throws(
      () => applyPromotion({ infantPromoCompareAtPrice: { CDF: 5_000 } }, free, null, routeSlots),
      /The baby fare has no price, so it cannot be on promotion/
   )
   // Each old price is held to its own price.
   const twelve = { sellPrice: { CDF: 513_000 }, twelveHourSellPrice: { CDF: 285_000 } }
   assert.throws(
      () => applyPromotion({ twelveHourPromoCompareAtPrice: { CDF: 285_000 } }, twelve, null, carSlots),
      /The old price of the 12-hour rate must be higher than its price, in FC, for a discount of at least 1%/
   )
})

check('an edit: a rate taken away takes its old price; a fare raised over its old price is refused', () => {
   const car = {
      sellPrice: { CDF: 513_000 },
      promoCompareAtPrice: { CDF: 600_000 },
      sixHourSellPrice: { CDF: 171_000 },
      sixHourPromoCompareAtPrice: { CDF: 200_000 },
      promoEndsAt: new Date(`${inDays(5)}T00:00:00Z`),
   }
   // The 6-hour rate removed (saved as 0): its old price goes, the 24-hour one stays.
   const removed: Record<string, any> = { sixHourSellPrice: { CDF: 0 } }
   applyPromotion({ sixHourSellPrice: {} }, removed, car, carSlots)
   assert.deepStrictEqual(removed, { sixHourSellPrice: { CDF: 0 }, sixHourPromoCompareAtPrice: { CDF: 0 } })
   // When it was the last price on promotion, the end date goes too.
   const last: Record<string, any> = { sixHourSellPrice: { CDF: 0 } }
   applyPromotion({ sixHourSellPrice: {} }, last, { ...car, promoCompareAtPrice: { CDF: 0 } }, carSlots)
   assert.deepStrictEqual([last.sixHourPromoCompareAtPrice, last.promoEndsAt], [{ CDF: 0 }, null])
   const bus = { sellPrice: { CDF: 42_800 }, childSellPrice: { CDF: 28_500 }, childPromoCompareAtPrice: { CDF: 35_000 } }
   assert.throws(
      () => applyPromotion({ childSellPrice: { CDF: 40_000 } }, { childSellPrice: { CDF: 40_000 } }, bus, routeSlots),
      /The old price of the child fare must be higher than its price, in FC, for a discount of at least 1%/
   )
   // A blank fare box keeps the fare stored, and so its promotion.
   const blank: Record<string, any> = { childSellPrice: {} }
   applyPromotion({ childSellPrice: {} }, blank, bus, routeSlots)
   assert.deepStrictEqual(blank, { childSellPrice: {} })
})

check('a promotion that has ended blocks no other edit', () => {
   const ended = {
      sellPrice: { CDF: 513_000 },
      sixHourSellPrice: { CDF: 171_000 },
      sixHourPromoCompareAtPrice: { CDF: 200_000 },
      twelveHourSellPrice: { CDF: 285_000 },
      twelveHourPromoCompareAtPrice: { CDF: 300_000 },
      promoEndsAt: new Date(`${inDays(-3)}T00:00:00Z`),
   }
   const edits: [Record<string, any>, Record<string, any>][] = [
      [{ title: { fr: 'Prado' } }, {}],
      [{ sixHourSellPrice: { CDF: 250_000 } }, { sixHourSellPrice: { CDF: 250_000 } }],
      [{ twelveHourSellPrice: {} }, { twelveHourSellPrice: { CDF: 0 } }],
      [{ twelveHourPromoCompareAtPrice: {} }, {}],
   ]
   for (const [body, patch] of edits) {
      assert.strictEqual(refused(() => applyPromotion(body, patch, ended, carSlots)), null, JSON.stringify(body))
   }
   // A new old price on it does ask for a new date.
   assert.throws(
      () => applyPromotion({ sixHourPromoCompareAtPrice: { CDF: 210_000 } }, {}, ended, carSlots),
      /The promotion end date is in the past: choose today or a later day/
   )
})

check('the biggest discount on any price, and what the public listing shows of each', () => {
   const ends = new Date(`${inDays(2)}T00:00:00Z`)
   const prado = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      vertical: 'CAR',
      title: { fr: 'Toyota Prado' },
      slug: 'prado',
      sellPrice: { CDF: 90_000 },
      promoCompareAtPrice: { CDF: 100_000 }, // −10 %
      hourlySellPrice: { CDF: 0 },
      hourlyPromoCompareAtPrice: { CDF: 99_000 }, // not rented by the hour: never shown
      sixHourSellPrice: { CDF: 35_000 },
      sixHourPromoCompareAtPrice: { CDF: 50_000 }, // −30 %
      twelveHourSellPrice: { CDF: 60_000 },
      promoEndsAt: ends,
   }
   assert.strictEqual(bestDiscountOf(prado), 30)
   assert.strictEqual(bestDiscountOf({ ...prado, promoEndsAt: new Date(`${inDays(-1)}T00:00:00Z`) }), 0)
   const car: any = JSON.parse(JSON.stringify(presentListing(prado as any)))
   assert.deepStrictEqual(
      car.rentalRates.map((r: any) => [r.hours, r.promotion?.discountPercent]),
      [[6, 30], [12, undefined], [24, 10]]
   )
   assert.deepStrictEqual(car.rentalRates[2].promotion, car.promotion)
   assert.deepStrictEqual(car.otherPromotion, { discountPercent: 30, endsAt: ends.toISOString(), hours: 6 })

   const bus: any = JSON.parse(
      JSON.stringify(
         presentListing({
            ...prado,
            vertical: 'BUS',
            promoCompareAtPrice: { CDF: 0 },
            childSellPrice: { CDF: 28_500 },
            childPromoCompareAtPrice: { CDF: 35_625 }, // −20 %
            infantSellPrice: { CDF: 0 },
            infantPromoCompareAtPrice: { CDF: 5_000 }, // babies travel free: never shown
            promoEndsAt: undefined,
         } as any)
      )
   )
   assert.strictEqual(bestDiscountOf({ ...prado, vertical: 'BUS', childSellPrice: { CDF: 28_500 }, childPromoCompareAtPrice: { CDF: 35_625 } }), 20)
   assert.ok(!bus.promotion && !bus.infantPromotion && !bus.rentalRates, JSON.stringify(bus))
   assert.strictEqual(bus.childPromotion.discountPercent, 20)
   assert.deepStrictEqual(bus.otherPromotion, { discountPercent: 20, fare: 'CHILD' })
   // An activity has one price: its child price is neither shown nor charged.
   const tour: any = presentListing({ ...prado, vertical: 'ACTIVITY', childSellPrice: { CDF: 1 }, childPromoCompareAtPrice: { CDF: 9 } } as any)
   assert.ok(tour.promotion && !tour.otherPromotion && !tour.childPromotion && !tour.rentalRates)
})

check('every promotion field is a field of a listing', () => {
   for (const f of PROMO_FIELDS.split(' ')) {
      assert.ok(Listing.schema.path(f === 'promoEndsAt' ? f : `${f}.CDF`), `${f} is not a listing field`)
   }
})

check('a sell price equal to its cost can be published; below it cannot (the processing fee is the margin)', () => {
   const priceBlockers = (doc: Record<string, unknown>) =>
      (new Listing({ images: ['/img/a.svg'], quantityTotal: 1, city: 'Kinshasa', ...doc }) as any)
         .publishBlockers()
         .filter((b: string) => /cost|price/i.test(b))
   const activity = { vertical: 'ACTIVITY', attributes: { durationMinutes: 60 } }
   assert.deepStrictEqual(priceBlockers({ ...activity, costPrice: { CDF: 10000 }, sellPrice: { CDF: 10000 } }), [])
   assert.deepStrictEqual(priceBlockers({ ...activity, costPrice: { CDF: 10000 }, sellPrice: { CDF: 9900 } }), [
      'The sell price cannot be below the cost price',
   ])
   const car = { vertical: 'CAR', attributes: { make: 'Toyota' }, costPrice: { CDF: 50000 }, sellPrice: { CDF: 50000 } }
   assert.deepStrictEqual(priceBlockers({ ...car, hourlyCostPrice: { CDF: 5000 }, hourlySellPrice: { CDF: 5000 } }), [])
   assert.ok(
      priceBlockers({ ...car, hourlyCostPrice: { CDF: 5000 }, hourlySellPrice: { CDF: 4000 } }).some((b: string) =>
         /cannot be below its cost/.test(b)
      )
   )
})

/** `check` for what has to be awaited (a model's validation, a notification). */
const checkAsync = async (name: string, fn: () => Promise<void>) => {
   try {
      await asClient(true, fn)
      console.log(`  ✓ ${name}`)
   } catch (err: any) {
      failures += 1
      console.error(`  ✗ ${name}\n      ${err.message}`)
   }
}
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
const ALL_EMPTY = { fr: '', en: '', pt: '', es: '', zh: '', ar: '', ru: '' }

const main = async () => {
   console.log('\nTexts per language (2026-10-31)')
   check('a text in any shape: a plain string is French, only content languages with text are kept', () => {
      assert.deepStrictEqual(toLocalized(' Pièce d’identité '), { fr: 'Pièce d’identité' })
      assert.deepStrictEqual(toLocalized({ fr: 'a', en: ' ', ru: 'б', xx: 'no', es: 3 }), { fr: 'a', ru: 'б' })
      ;[undefined, null, '', ['a'], 5].forEach((v) => assert.deepStrictEqual(toLocalized(v), {}))
   })

   check('the language chain: asked → English → French (French: French → English); a legacy string is itself', () => {
      assert.strictEqual(resolveLocalized({ fr: 'F', en: 'E', zh: 'Z' }, 'zh'), 'Z')
      assert.strictEqual(resolveLocalized({ fr: 'F', en: 'E' }, 'zh'), 'E')
      assert.strictEqual(resolveLocalized({ fr: 'F' }, 'ar'), 'F')
      assert.strictEqual(resolveLocalized({ en: 'E' }, 'fr'), 'E')
      assert.strictEqual(resolveLocalized({ fr: 'F', en: 'E' }), 'F')
      assert.strictEqual(resolveLocalized('Ancien texte', 'en'), 'Ancien texte')
      // The payment page has French and English only: English for every other language, and for none.
      assert.deepStrictEqual(['fr', undefined, 'en', 'zh', 'ar'].map(payPageLanguage), ['fr', 'en', 'en', 'en', 'en'])
   })

   await checkAsync('a hotel: policies stored per language, translations kept only for listed words', async () => {
      const h = new Hotel({
         name: { fr: 'Hôtel du Fleuve' },
         slug: 'fleuve',
         city: 'Kinshasa',
         policies: "Pièce d'identité demandée",
         amenities: ['Piscine', 'Wifi gratuit'],
         // Map in: French is the word, so a French sent is ignored; Parking is not listed.
         tagTranslations: { Piscine: { fr: 'x', en: 'Pool', zh: '游泳池', ar: '' }, 'Wifi gratuit': { en: '' }, Parking: { en: 'Parking' } },
      })
      await h.validate()
      assert.deepStrictEqual(plain(h.policies), { fr: "Pièce d'identité demandée" })
      assert.deepStrictEqual(plain(h.tagTranslations), [{ tag: 'Piscine', text: { en: 'Pool', zh: '游泳池' } }])
      // A word taken off the list takes its translation with it, on the next save.
      h.amenities = ['Wifi gratuit']
      await h.validate()
      assert.deepStrictEqual(plain(h.tagTranslations), [])

      const admin: any = presentAdminHotel(h)
      assert.deepStrictEqual(admin.policies, { ...ALL_EMPTY, fr: "Pièce d'identité demandée" })
      h.amenities = ['Piscine', 'Wifi gratuit']
      h.tagTranslations = { Piscine: { en: 'Pool' } } as any
      await h.validate()
      assert.deepStrictEqual({ ...(presentAdminHotel(h) as any).tagTranslations }, { Piscine: { ...ALL_EMPTY, fr: 'Piscine', en: 'Pool' } })
      // Public: only words with a translation, only languages with text, French being the word.
      const pub: any = plain(presentHotel(h.toObject() as any))
      assert.deepStrictEqual({ ...pub.tagTranslations }, { Piscine: { fr: 'Piscine', en: 'Pool' } })
      assert.deepStrictEqual(pub.policies, { fr: "Pièce d'identité demandée" })
   })

   check('a record from before languages reads on: its string is French, admin and public', () => {
      const h = Hotel.hydrate({
         _id: new Types.ObjectId(),
         name: { fr: 'Ancien' },
         slug: 'ancien',
         city: 'Goma',
         policies: 'Texte ancien',
         amenities: ['Piscine'],
      })
      assert.strictEqual(h.policies, 'Texte ancien', 'read as stored, no migration')
      assert.deepStrictEqual((presentAdminHotel(h) as any).policies, { ...ALL_EMPTY, fr: 'Texte ancien' })
      assert.deepStrictEqual({ ...(presentAdminHotel(h) as any).tagTranslations }, {})
      const pub: any = presentHotel(h.toObject() as any)
      assert.deepStrictEqual(pub.policies, { fr: 'Texte ancien' })
      assert.deepStrictEqual({ ...pub.tagTranslations }, {})
      // Stale translations in the database (a word since removed) never leave.
      const stale = Hotel.hydrate({ ...h.toObject(), tagTranslations: [{ tag: 'Sauna', text: { en: 'Sauna' } }] })
      assert.deepStrictEqual({ ...(presentAdminHotel(stale) as any).tagTranslations }, {})
      assert.deepStrictEqual({ ...(presentHotel(stale.toObject() as any) as any).tagTranslations }, {})
   })

   await checkAsync('a restaurant: opening hours and zone names per language; a zone needs its French name', async () => {
      const zone = { fee: { CDF: 2_000 } }
      const r = new Restaurant({
         name: { fr: 'Chez Mama' },
         slug: 'mama',
         city: 'Kinshasa',
         openingHours: { fr: 'Lun–Sam 11h–22h', en: 'Mon–Sat 11am–10pm', pt: '' },
         cuisines: ['Congolais'],
         deliveryZones: [{ ...zone, name: 'Gombe' }, { ...zone, name: { fr: 'Limete', en: 'Limete' } }],
      })
      await r.validate()
      assert.deepStrictEqual(plain(r.openingHours), { fr: 'Lun–Sam 11h–22h', en: 'Mon–Sat 11am–10pm' })
      assert.deepStrictEqual(plain(r.deliveryZones.map((z: any) => z.name)), [{ fr: 'Gombe' }, { fr: 'Limete', en: 'Limete' }])
      const admin: any = presentAdminRestaurant(r)
      assert.deepStrictEqual(admin.deliveryZones[0].name, { ...ALL_EMPTY, fr: 'Gombe' })
      const pub: any = plain(presentRestaurant(r.toObject() as any))
      assert.deepStrictEqual(pub.deliveryZones[1].name, { fr: 'Limete', en: 'Limete' })
      assert.deepStrictEqual(pub.openingHours, { fr: 'Lun–Sam 11h–22h', en: 'Mon–Sat 11am–10pm' })

      const noFrench = new Restaurant({ ...r.toObject(), _id: undefined, deliveryZones: [{ ...zone, name: { en: 'Gombe' } }] })
      await assert.rejects(noFrench.validate(), /French text is required/)
   })

   await checkAsync('an app built before languages (no ?i18n=1) still gets each text as one French string', async () => {
      const zone = { fee: { CDF: 2_000 } }
      const r = new Restaurant({
         name: { fr: 'Chez Mama' },
         slug: 'mama-old',
         city: 'Kinshasa',
         openingHours: { fr: 'Lun–Sam 11h–22h', zh: '周一至周六' },
         deliveryZones: [{ ...zone, name: { fr: 'Limete', ar: 'ليميتي' } }],
      })
      await r.validate()
      const old: any = plain(asClient(false, () => presentRestaurant(r.toObject() as any)))
      assert.strictEqual(old.openingHours, 'Lun–Sam 11h–22h')
      assert.strictEqual(old.deliveryZones[0].name, 'Limete')
      const now: any = plain(presentRestaurant(r.toObject() as any))
      assert.deepStrictEqual(now.openingHours, { fr: 'Lun–Sam 11h–22h', zh: '周一至周六' })
   })

   await checkAsync('a listing: attribute texts per language, list words translated, both shown right', async () => {
      const l = new Listing({
         vertical: 'ACTIVITY',
         title: { fr: 'Visite du marché' },
         slug: 'marche',
         city: 'Kinshasa',
         attributes: {
            durationMinutes: 120,
            meetingPoint: 'Devant la poste',
            languages: ['Français', 'Anglais'],
            inclusions: ['Guide'],
         },
         tagTranslations: { Français: { en: 'French' }, Guide: { en: 'Guide', zh: '导游' }, Retiré: { en: 'Gone' } },
      })
      await l.validate()
      assert.deepStrictEqual(plain(l.attributes.meetingPoint), { fr: 'Devant la poste' })
      assert.deepStrictEqual(plain(l.tagTranslations).map((t: any) => t.tag), ['Français', 'Guide'])

      const admin: any = plain(presentAdminListing(l))
      assert.deepStrictEqual(admin.attributes.meetingPoint, { ...ALL_EMPTY, fr: 'Devant la poste' })
      assert.deepStrictEqual(admin.attributes.languages, ['Français', 'Anglais'], 'the words stay French')
      assert.deepStrictEqual(admin.tagTranslations.Guide, { ...ALL_EMPTY, fr: 'Guide', en: 'Guide', zh: '导游' })

      l.attributes.meetingPoint = { fr: 'Devant la poste', en: 'Outside the post office', ru: ' ' }
      const pub: any = plain(presentListing(l))
      assert.deepStrictEqual(pub.attributes.meetingPoint, { fr: 'Devant la poste', en: 'Outside the post office' })
      assert.deepStrictEqual({ ...pub.tagTranslations }, { Français: { fr: 'Français', en: 'French' }, Guide: { fr: 'Guide', en: 'Guide', zh: '导游' } })
      assert.ok(!('fareRules' in pub.attributes), 'an unset text is not sent')
      // A text with nothing in any language is not sent at all.
      const empty: any = plain(presentListing(Listing.hydrate({ ...l.toObject(), attributes: { meetingPoint: '' } })))
      assert.ok(!('meetingPoint' in empty.attributes), JSON.stringify(empty.attributes))
      // A bus class is one word, treated as a list word.
      const bus = new Listing({ vertical: 'BUS', title: { fr: 'K→M' }, slug: 'km', city: 'Kinshasa', attributes: { vehicleClass: 'Climatisé' }, tagTranslations: { Climatisé: { en: 'Air-conditioned' } } })
      await bus.validate()
      assert.deepStrictEqual({ ...(presentListing(bus) as any).tagTranslations }, { Climatisé: { fr: 'Climatisé', en: 'Air-conditioned' } })
      // Any word is a word, whatever an object happens to call its own.
      assert.deepStrictEqual(plain(tagTranslationsOf([{ tag: 'constructor', text: { en: 'x' } }], ['constructor'], false)), {
         constructor: { fr: 'constructor', en: 'x' },
      })
   })

   check('the spreadsheet: a text per language leaves as its French; a legacy string as itself', () => {
      const col = { key: 'policies', kind: 'text', path: 'policies' } as any
      assert.strictEqual(writeCell(col, { policies: { fr: 'Pièce demandée', en: 'ID required' } }, ','), 'Pièce demandée')
      assert.strictEqual(writeCell(col, { policies: { en: 'ID required' } }, ','), '')
      assert.strictEqual(writeCell(col, { policies: 'Ancien' }, ','), 'Ancien')
      const meeting = { key: 'meeting_point', kind: 'text', path: 'attributes.meetingPoint' } as any
      assert.strictEqual(writeCell(meeting, { attributes: { meetingPoint: { fr: 'La poste' } } }, ';'), 'La poste')
      // An import writes the cell's text as the French one.
      assert.deepStrictEqual(plain(new Listing({ attributes: { meetingPoint: 'La poste' } }).attributes.meetingPoint), { fr: 'La poste' })
   })

   await checkAsync("a notification goes in the customer's language, then English, then French", async () => {
      const texts: string[] = []
      ;(NotificationTemplate as any).find = async () => [
         { channel: 'SMS', body: { fr: 'Réservation {{order_ref}}', en: 'Booking {{order_ref}}', zh: '预订 {{order_ref}}' } },
      ]
      ;(NotificationLog as any).create = async () => undefined
      ;(smsService as any).smsConfigured = () => true
      ;(smsService as any).sendSms = async (_to: string, body: string) => {
         texts.push(body)
         return { sid: 'SM1', status: 'queued' }
      }
      const send = (locale?: string) =>
         notify({ event: 'ORDER_CONFIRMED', recipient: '+243810000042', vars: { order_ref: 'FA-1' }, locale })
      for (const l of ['zh', 'ar', 'fr', 'en', undefined]) await send(l)
      assert.deepStrictEqual(texts.splice(0), ['预订 FA-1', 'Booking FA-1', 'Réservation FA-1', 'Booking FA-1', 'Réservation FA-1'])
      // A template saved before languages: its one text for everyone.
      ;(NotificationTemplate as any).find = async () => [{ channel: 'SMS', body: 'Booking {{order_ref}}' }]
      await send('zh')
      assert.deepStrictEqual(texts, ['Booking FA-1'])
   })

   check("a customer's language: the first of the seven given, else French; a legacy text stays French", () => {
      assert.strictEqual(customerLocale(undefined, null, ''), 'fr')
      assert.strictEqual(customerLocale('de', 'EN', 7), 'fr')
      assert.strictEqual(customerLocale(undefined, 'fr'), 'fr')
      assert.strictEqual(customerLocale('zh', 'fr'), 'zh')
      assert.strictEqual(knownLocale('xx'), undefined)
      // A new record that was told no language has none, not French.
      assert.strictEqual(new Customer({ phone: '+243810000042', firstName: 'Aline' }).locale, undefined)
      assert.strictEqual(resolveLocalized({ fr: 'F', en: 'E' }), 'F', 'the office and legacy default is French')
   })

   await checkAsync('an order message: the booking language, then the record, then French', async () => {
      const texts: string[] = []
      ;(NotificationTemplate as any).find = async () => [
         { channel: 'SMS', body: { fr: 'Réservation {{order_ref}}', en: 'Booking {{order_ref}}', zh: '预订 {{order_ref}}' } },
      ]
      ;(smsService as any).sendSms = async (_to: string, body: string) => {
         texts.push(body)
         return { sid: 'SM1', status: 'queued' }
      }
      const orderOf = (consent?: object, locale?: string) => {
         ;(Order as any).findById = async () => ({ _id: new Types.ObjectId(), reference: 'FA-2', chargedTotal: 1_000, chargedCurrency: 'CDF', items: [{ vertical: 'HOTEL' }], consent })
         ;(Customer as any).findById = async () => ({ _id: new Types.ObjectId(), phone: '+243810000042', firstName: 'Aline', locale })
         return notifyOrder('ORDER_CONFIRMED', new Types.ObjectId(), { sms: true })
      }
      await orderOf()
      await orderOf({}, 'zh')
      await orderOf({ locale: 'fr' }, 'zh')
      await orderOf(undefined, 'xx')
      assert.deepStrictEqual(texts, ['Réservation FA-2', '预订 FA-2', 'Réservation FA-2', 'Réservation FA-2'])
   })

   await checkAsync('signing up, signing in and the profile record the language in use; anything else is ignored', async () => {
      process.env.JWT_SECRET ||= 'self-check only'
      // The controller's answer: the response body, or what it passed to next().
      const call = (handler: any, body: object, customer?: object) =>
         new Promise<any>((resolve) => {
            const res: any = { set: () => res, status: () => res, cookie: () => res, json: resolve }
            handler({ body, customer }, res, resolve)
         })
      const sets: any[] = []
      const account: any = { _id: new Types.ObjectId(), phone: '+243810000042', firstName: 'Aline', hasAccount: true, locale: 'fr' }
      let found: any = null
      ;(Customer as any).findOne = () => ({ select: async () => found })
      ;(Customer as any).findById = async () => account
      ;(Customer as any).create = async (doc: object) => ({ ...doc, _id: account._id })
      ;(Customer as any).updateOne = async (_q: unknown, update: any) => void sets.push(update.$set)
      const code = { _id: 1, expiresAt: new Date(Date.now() + 60_000), codeHash: hashOtp('123456'), attempts: 1 }
      ;(PhoneVerification as any).findOne = async () => code
      ;(PhoneVerification as any).findOneAndUpdate = async () => code
      ;(PhoneVerification as any).deleteOne = async () => undefined

      const signUp = { phone: account.phone, code: '123456', firstName: 'Aline', password: 'long enough 1' }
      for (const locale of ['zh', 'de', undefined]) {
         const out = await call(verifyOtp, { ...signUp, locale })
         assert.ok(out.token, `sign-up with ${locale}: ${out.message}`)
      }
      assert.deepStrictEqual(sets.splice(0).map((s) => s.locale), ['zh', undefined, undefined])

      found = { ...account, password: await hashPassword(signUp.password) }
      for (const locale of ['ar', 'fr', 'xx', 7]) {
         const out = await call(login, { phone: account.phone, password: signUp.password, locale })
         assert.ok(out.token, `sign-in with ${locale}: ${out.message}`)
      }
      // French is already theirs: nothing to write.
      assert.deepStrictEqual(sets.splice(0), [{ locale: 'ar' }])

      for (const locale of ['ru', 'EN', null]) await call(updateMe, { locale }, account)
      assert.deepStrictEqual(sets.splice(0), [{ locale: 'ru' }, {}, {}])
   })

   console.log('\nVehicles for sale (2026-11-04)')
   check('a vehicle line stands alone and is one vehicle; other orders are untouched', () => {
      const car = { vertical: 'VEHICLE_SALE', listingId: 'x', quantity: 1 }
      assert.strictEqual(vehicleSaleRefusal([car]), null)
      assert.strictEqual(vehicleSaleRefusal([{ vertical: 'RESTAURANT', quantity: 3 }, { vertical: 'RESTAURANT', quantity: 1 }]), null)
      assert.strictEqual(vehicleSaleRefusal([car, { vertical: 'HOTEL', quantity: 1 }])?.[1], 'VEHICLE_ALONE')
      assert.strictEqual(vehicleSaleRefusal([car, { ...car, listingId: 'y' }])?.[1], 'VEHICLE_ALONE')
      assert.strictEqual(vehicleSaleRefusal([{ ...car, quantity: 2 }])?.[1], 'VEHICLE_QUANTITY')
      assert.strictEqual(vehicleSaleRefusal([{ ...car, quantity: '1' }]), null, 'a quantity sent as text is still one')
   })

   await checkAsync('checkout answers 400 for a vehicle beside another line, or two of it, before pricing anything', async () => {
      ;(Order as any).findOne = async () => null
      const post = (items: unknown[]) =>
         new Promise<any>((resolve) => {
            const req: any = { header: (h: string) => (h === 'Idempotency-Key' ? 'k-1' : undefined), headers: {}, body: { items } }
            const res: any = { set: () => res, status: () => res, json: resolve }
            createOrder(req, res, resolve)
         })
      const car = { vertical: 'VEHICLE_SALE', listingId: String(new Types.ObjectId()), quantity: 1 }
      const mixed = await post([car, { vertical: 'RESTAURANT', listingId: 'd', quantity: 1 }])
      assert.strictEqual(mixed?.statusCode, 400, `mixed: ${mixed?.message}`)
      assert.strictEqual(mixed.code, 'VEHICLE_ALONE')
      const two = await post([{ ...car, quantity: 2 }])
      assert.strictEqual(two?.statusCode, 400, `quantity 2: ${two?.message}`)
      assert.strictEqual(two.code, 'VEHICLE_QUANTITY')
   })

   // Two vehicles, each reserved by its own order, and an update that honours its filter as Mongo would.
   const ordA = new Types.ObjectId()
   const ordB = new Types.ObjectId()
   const carA: any = { _id: new Types.ObjectId(), availability: 'RESERVED', reservedOrder: ordA }
   const carB: any = { _id: new Types.ObjectId(), availability: 'RESERVED', reservedOrder: ordB }
   ;(SaleVehicle as any).updateOne = async (filter: any, update: any) => {
      const hit = [carA, carB].find((v) => Object.entries(filter).every(([k, want]) => String(v[k]) === String(want)))
      if (hit) {
         Object.assign(hit, update.$set ?? {})
         for (const k of Object.keys(update.$unset ?? {})) delete hit[k]
      }
      return { modifiedCount: hit ? 1 : 0 }
   }
   const line = (car: any) => ({ vertical: 'VEHICLE_SALE', listingId: new Types.ObjectId(), roomTypeId: car._id, quantity: 1, stockRef: 'VS-000001' })
   const orderDoc = (id: Types.ObjectId, car: any, over: Record<string, unknown> = {}) => {
      const o: any = {
         _id: id,
         reference: 'FA-VS',
         status: 'SUBMITTED',
         paymentStatus: 'UNPAID',
         paymentMethod: 'CASH',
         items: [line(car)],
         timeline: [],
         save: async () => o,
         toObject: () => ({ ...o }),
         ...over,
      }
      return o
   }
   const office = (order: any, body: Record<string, unknown>) =>
      new Promise<any>((resolve) => {
         ;(Order as any).findById = async () => order
         const req: any = { params: { id: String(order._id) }, body, admin: { email: 'office@test' }, get: () => '', ip: '' }
         const res: any = { set: () => res, status: () => res, json: resolve }
         transitionOrder(req, res, resolve)
      })
   ;(AuditLog as any).create = async (doc: any) => doc
   ;(Ride as any).findOne = async () => null
   ;(Customer as any).findById = () => ({ select: async () => null })
   ;(NotificationLog as any).create = async () => undefined
   ;(settingsModel as any).getSettings = async () => ({})

   await checkAsync("the office cancelling releases only the vehicle that order reserved", async () => {
      // An order naming B, which order B holds: cancelling it frees nothing.
      const stale = await office(orderDoc(ordA, carB), { to: 'CANCELLED', reason: 'test', cancellationReason: 'OTHER' })
      assert.ok(!stale?.statusCode, stale?.message)
      assert.strictEqual(carB.availability, 'RESERVED', "another order's vehicle was released")
      assert.strictEqual(String(carB.reservedOrder), String(ordB))
      const out = await office(orderDoc(ordA, carA), { to: 'CANCELLED', reason: 'test', cancellationReason: 'CUSTOMER_REQUEST' })
      assert.ok(!out?.statusCode, out?.message)
      assert.strictEqual(carA.availability, 'AVAILABLE')
      assert.ok(!('reservedOrder' in carA), 'the released vehicle still names the order')
   })

   await checkAsync('the office completing a paid order marks its vehicle sold, and only that one', async () => {
      const out = await office(orderDoc(ordB, carB, { status: 'CONFIRMED', paymentStatus: 'PAID', fulfilmentStatus: 'DOCUMENTS_ISSUED' }), { to: 'COMPLETED', reason: 'handed over' })
      assert.ok(!out?.statusCode, out?.message)
      assert.strictEqual(carB.availability, 'SOLD')
      assert.ok(carB.soldAt instanceof Date, 'no soldAt')
      assert.strictEqual(String(carB.reservedOrder), String(ordB), 'a sold vehicle keeps the order that bought it')
      // A's order was cancelled: completing it cannot sell A (and an unpaid one is refused anyway).
      assert.strictEqual(carA.availability, 'AVAILABLE')
   })

   await checkAsync('the unpaid-cash expiry job releases the vehicle its order reserved', async () => {
      const ordC = new Types.ObjectId()
      Object.assign(carA, { availability: 'RESERVED', reservedOrder: ordC })
      const lapsed = orderDoc(ordC, carA)
      ;(Order as any).find = () => ({ limit: async () => [lapsed] })
      ;(Listing as any).updateOne = async () => ({ modifiedCount: 0 })
      ;(Customer as any).updateOne = async () => undefined
      assert.strictEqual(await releaseExpiredCashHolds(), 1)
      assert.strictEqual(lapsed.status, 'CANCELLED')
      assert.strictEqual(carA.availability, 'AVAILABLE')
      assert.strictEqual(carB.availability, 'SOLD', 'a sold vehicle came back on sale')
   })


   console.log('\nThe office workflow (2026-11-06): payment → documents → completion')
   const act = (handler: any, order: any, body: Record<string, unknown> = {}) =>
      new Promise<any>((resolve) => {
         ;(Order as any).findById = async () => order
         const req: any = { params: { id: String(order._id) }, body, admin: { email: 'office@test' }, get: () => '', ip: '' }
         const res: any = { set: () => res, status: () => res, json: resolve }
         handler(req, res, resolve)
      })
   const booking = (over: Record<string, unknown> = {}) => {
      const o: any = {
         _id: new Types.ObjectId(),
         reference: 'FA-WF',
         status: 'SUBMITTED',
         paymentStatus: 'UNPAID',
         paymentMethod: 'CASH',
         fulfilmentStatus: 'NOT_STARTED',
         items: [{ vertical: 'HOTEL', listingId: new Types.ObjectId(), quantity: 1 }],
         documents: [],
         timeline: [],
         save: async () => o,
         toObject: () => ({ ...o }),
         ...over,
      }
      return o
   }
   ;(Order as any).updateOne = async () => ({ modifiedCount: 0 })

   await checkAsync('a cash booking walks cash pending → paid, pending document → document delivered → completed', async () => {
      const o = booking()
      assert.strictEqual(orderStage(o), 'CASH_PENDING')
      // Completing or handing documents over before the money is refused.
      assert.strictEqual((await act(markDocumentsDelivered, o))?.statusCode, 409)
      const paid = await act(markCashReceived, o, { reason: '' })
      assert.ok(!paid?.statusCode, paid?.message)
      assert.strictEqual(orderStage(o), 'CASH_PAID_PENDING_DOCUMENT')
      // No completing before the documents.
      const early = await act(transitionOrder, o, { to: 'COMPLETED' })
      assert.strictEqual(early?.statusCode, 409, 'completed before the documents were handed over')
      const docs = await act(markDocumentsDelivered, o)
      assert.ok(!docs?.statusCode, docs?.message)
      assert.strictEqual(orderStage(o), 'DOCUMENT_DELIVERED_PENDING_COMPLETION')
      assert.strictEqual((await act(markDocumentsDelivered, o))?.statusCode, 409, 'confirmed twice')
      // Moving on along the workflow needs no typed reason.
      const done = await act(transitionOrder, o, { to: 'COMPLETED' })
      assert.ok(!done?.statusCode, done?.message)
      assert.strictEqual(orderStage(o), 'COMPLETED')
   })

   await checkAsync('no separate "confirm"; a booking confirmed that way before can still have its cash recorded', async () => {
      const refused = await act(transitionOrder, booking(), { to: 'CONFIRMED', reason: 'ok' })
      assert.strictEqual(refused?.statusCode, 400)
      const legacy = booking({ status: 'CONFIRMED' })
      assert.strictEqual(orderStage(legacy), 'CASH_PENDING')
      const paid = await act(markCashReceived, legacy, { reason: 'Collected at office' })
      assert.ok(!paid?.statusCode, paid?.message)
      assert.strictEqual(legacy.paymentStatus, 'PAID')
      assert.strictEqual((await act(markCashReceived, legacy))?.statusCode, 409, 'paid twice')
   })

   await checkAsync('cancelling still needs a reason', async () => {
      const out = await act(transitionOrder, booking(), { to: 'CANCELLED', cancellationReason: 'OTHER' })
      assert.strictEqual(out?.statusCode, 400)
   })

   check('a meal or a ride, once paid, waits only for completion; an online one reads "payment"', () => {
      const meal = booking({ paymentStatus: 'PAID', status: 'CONFIRMED', delivery: { address: 'Gombe' } })
      assert.strictEqual(orderStage(meal), 'PAID_PENDING_COMPLETION')
      const ride = booking({ paymentStatus: 'PAID', status: 'CONFIRMED', items: [{ vertical: 'TRANSFER' }] })
      assert.strictEqual(orderStage(ride), 'PAID_PENDING_COMPLETION')
      assert.strictEqual(orderStage(booking({ paymentMethod: 'ONLINE', paymentStatus: 'PENDING' })), 'PAYMENT_PENDING')
      assert.strictEqual(orderStage(booking({ status: 'CANCELLED', paymentStatus: 'PAID' })), 'CANCELLED')
   })

   console.log('\nProcessing fees (2026-11-05)')
   check('a fee box is whole francs; blank is 0 (no fee), absent leaves it, below 0 is a 400', () => {
      assert.deepStrictEqual(parseFee({ CDF: '5700' }), { CDF: 5_700 })
      assert.deepStrictEqual(parseFee({ CDF: '' }), { CDF: 0 })
      assert.deepStrictEqual(parseFee(2_000), { CDF: 2_000 })
      assert.strictEqual(parseFee(undefined), undefined)
      assert.strictEqual(refused(() => parseFee({ CDF: -1 })), 400)
   })

   // Checkout, end to end, with every lookup stubbed: what the order is written with, and what it answers.
   const inDaysUtc = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
   ;(SettingsModel as any).findOne = () => ({ select: () => ({ lean: async () => ({ exchangeRates: { USD: 2_850, EUR: 3_100 } }) }) })
   await refreshRates()
   ;(settingsModel as any).getSettings = async () => ({ holdTtlCashHours: 24 })
   ;(settingsModel.PolicyVersion as any).findOne = () => ({ sort: async () => ({ _id: new Types.ObjectId(), label: 'v1', body: 'No refund', locale: 'en' }) })
   ;(Customer as any).findOneAndUpdate = async () => ({ _id: new Types.ObjectId(), hasAccount: false })
   ;(Order as any).findById = async () => null // the order's messages: nothing to send in a check
   let written: any = null
   ;(Order as any).create = async (doc: any) => {
      written = doc
      return { ...doc, populate: async () => undefined }
   }
   let n = 0
   const checkout = async (items: unknown[], extra: Record<string, unknown> = {}) => {
      written = null
      ;(Order as any).findOne = async () => null
      const answer = await new Promise<any>((resolve) => {
         const req: any = {
            header: (h: string) => (h === 'Idempotency-Key' ? `fee-${++n}` : undefined),
            headers: {},
            ip: '127.0.0.1',
            body: { items, contact: { firstName: 'Aline', lastName: 'K', phone: '0810000042' }, paymentMethod: 'CASH', locale: 'en', ...extra },
         }
         const res: any = { set: () => res, status: () => res, json: resolve }
         createOrder(req, res, resolve)
      })
      assert.ok(written, `no order written: ${answer?.message}`)
      return { doc: written, order: answer.order }
   }

   const flight = (fee?: number) =>
      Listing.hydrate({
         _id: new Types.ObjectId(),
         vertical: 'FLIGHT',
         status: 'PUBLISHED',
         title: { fr: 'Kinshasa → Lubumbashi' },
         slug: 'fih-fbm',
         city: 'Kinshasa',
         costPrice: { CDF: 200_000 },
         sellPrice: { CDF: 285_000 },
         ...(fee === undefined ? {} : { processingFee: { CDF: fee } }),
         attributes: { destination: 'Lubumbashi', dailyTimes: ['08:00'] },
      })
   const flightLine = (l: any) => ({
      vertical: 'FLIGHT',
      listingId: String(l._id),
      quantity: 10,
      startDate: `${inDaysUtc(10)}T08:00`,
      passengers: { adults: 10 },
      baggage: { cabinKg: 7, checkedKg: 23 },
   })

   await checkAsync('10 flight tickets with a 5,700 FC fee: the fee once, in the total, never an item', async () => {
      const l = flight(5_700)
      ;(Listing as any).findOne = async () => l
      const { doc, order } = await checkout([flightLine(l)])
      assert.strictEqual(doc.items.length, 1, 'the fee became an item')
      assert.strictEqual(doc.items[0].lineTotal, 2_850_000)
      assert.strictEqual(doc.total, 2_855_700)
      assert.strictEqual(doc.processingFee, 5_700)
      assert.strictEqual(doc.processingFeeCharged, 5_700, 'charged in francs')
      assert.strictEqual(order.processingFee, 5_700)
      assert.strictEqual(order.processingFeeCharged, 5_700)
      // In dollars: $2.00 once, beside $1,000.00 of tickets.
      const usd = await checkout([flightLine(l)], { currency: 'USD' })
      assert.strictEqual(usd.doc.chargedCurrency, 'USD')
      assert.strictEqual(usd.doc.chargedTotal, 100_200)
      assert.strictEqual(usd.doc.processingFeeCharged, 200)
      assert.strictEqual(usd.doc.total, 2_855_700)
      const admin: any = presentAdminOrder({ ...usd.doc, _id: new Types.ObjectId() } as any)
      assert.strictEqual(admin.processingFee, 5_700)
      assert.strictEqual(admin.processingFeeCharged, 200)
   })

   await checkAsync('no fee, or a 0 fee: the total is the lines, and the order has no processingFee', async () => {
      for (const l of [flight(), flight(0)]) {
         ;(Listing as any).findOne = async () => l
         const { doc, order } = await checkout([flightLine(l)])
         assert.strictEqual(doc.total, 2_850_000)
         assert.ok(!('processingFee' in doc) && !('processingFeeCharged' in doc), `written with ${Object.keys(doc)}`)
         // As it goes on the wire.
         const sent = plain(order)
         assert.ok(!('processingFee' in sent) && !('processingFeeCharged' in sent), 'the public order sends a fee')
         assert.ok(!('processingFee' in (presentAdminOrder({ ...doc, _id: new Types.ObjectId() } as any) as any)), 'the admin order sends a fee')
      }
   })

   await checkAsync('a restaurant order of 3 dishes: its fee once, the delivery fee unchanged', async () => {
      const zoneId = new Types.ObjectId()
      const r = Restaurant.hydrate({
         _id: new Types.ObjectId(),
         status: 'PUBLISHED',
         name: { fr: 'Chez Mama' },
         slug: 'mama-fee',
         city: 'Kinshasa',
         processingFee: { CDF: 1_500 },
         deliveryZones: [{ _id: zoneId, name: { fr: 'Gombe' }, fee: { CDF: 2_000 }, isActive: true, etaMinutes: 30 }],
      })
      const dishes = [10_000, 12_000, 8_000].map((price) => ({
         _id: new Types.ObjectId(),
         restaurant: r._id,
         name: { fr: 'Plat' },
         sellPrice: { CDF: price },
         costPrice: { CDF: price / 2 },
         isAvailable: true,
      }))
      ;(MenuItem as any).findOne = async (q: any) => dishes.find((d) => String(d._id) === String(q._id))
      ;(Restaurant as any).findOne = async () => r
      const { doc, order } = await checkout(
         dishes.map((d, i) => ({ vertical: 'RESTAURANT', listingId: String(d._id), quantity: i + 1 })),
         { delivery: { zoneId: String(zoneId), address: '12 avenue du Port' } }
      )
      const food = 10_000 * 1 + 12_000 * 2 + 8_000 * 3
      assert.strictEqual(doc.items.length, 3)
      assert.strictEqual(doc.delivery.fee, 2_000)
      assert.strictEqual(doc.processingFee, 1_500)
      assert.strictEqual(doc.total, food + 2_000 + 1_500)
      assert.strictEqual(order.delivery.fee, 2_000)
      assert.strictEqual(order.processingFee, 1_500)
   })

   await checkAsync("a hotel stay of 2 rooms × 3 nights: the hotel's fee once", async () => {
      const hotel = Hotel.hydrate({ _id: new Types.ObjectId(), status: 'PUBLISHED', name: { fr: 'Fleuve' }, slug: 'fleuve-fee', city: 'Kinshasa', processingFee: { CDF: 10_000 } })
      const room = RoomType.hydrate({ _id: new Types.ObjectId(), hotel: hotel._id, status: 'PUBLISHED', name: { fr: 'Double' }, sellPrice: { CDF: 100_000 }, costPrice: { CDF: 70_000 } })
      ;(RoomType as any).findOne = async () => room
      ;(Hotel as any).findOne = () => ({ select: async () => hotel })
      const { doc } = await checkout([
         { vertical: 'HOTEL', listingId: String(hotel._id), roomTypeId: String(room._id), quantity: 2, startDate: inDaysUtc(5), endDate: inDaysUtc(8) },
      ])
      assert.strictEqual(doc.items[0].lineTotal, 600_000)
      assert.strictEqual(doc.processingFee, 10_000)
      assert.strictEqual(doc.total, 610_000)
   })

   await checkAsync("a ride: its category's fee once, whatever the hours, in the quote and on the order", async () => {
      const category = VehicleCategory.hydrate({
         _id: new Types.ObjectId(),
         name: { fr: 'Berline' },
         seats: 4,
         pricePerHour: { CDF: 30_000 },
         costPerHour: { CDF: 20_000 },
         processingFee: { CDF: 3_000 },
         isActive: true,
      })
      ;(VehicleCategory as any).find = () => ({ sort: () => ({ limit: async () => [category] }) })
      ;(Location as any).exists = async () => true
      ;(Ride as any).create = async (doc: any) => ({ ...doc, status: 'PENDING', save: async () => undefined })
      const transfer = {
         city: 'Kinshasa',
         mode: 'HOURLY',
         hours: 3,
         pickup: { label: 'Aéroport de Ndjili', lat: -4.3858, lng: 15.4446 },
         at: `${inDaysUtc(3)}T10:00`,
         passengers: 2,
         categoryId: String(category._id),
      }
      const quote = await new Promise<any>((resolve) => {
         const res: any = { set: () => res, status: () => res, json: resolve }
         quoteTransfer({ body: transfer } as any, res, resolve)
      })
      assert.deepStrictEqual(quote.quotes[0].processingFee, { CDF: 3_000, USD: 106, EUR: 97 })
      assert.deepStrictEqual(presentPublicCategory(category).processingFee, { CDF: 3_000, USD: 106, EUR: 97 })
      const { doc } = await checkout([{ vertical: 'TRANSFER', quantity: 1, transfer }])
      assert.strictEqual(doc.items[0].lineTotal, 90_000)
      assert.strictEqual(doc.processingFee, 3_000)
      assert.strictEqual(doc.total, 93_000)
   })

   check('the public catalogue sends the fee as it sends sellPrice, absent when 0, and never a cost', () => {
      const fee = { CDF: 5_700, USD: 200, EUR: 184 }
      const listing: any = plain(presentListing(flight(5_700)))
      assert.deepStrictEqual(listing.processingFee, fee)
      assert.ok(!('processingFee' in (plain(presentListing(flight(0))) as any)))
      const hotel: any = plain(presentHotel({ ...Hotel.hydrate({ _id: new Types.ObjectId(), name: { fr: 'H' }, slug: 'h', city: 'K', processingFee: { CDF: 5_700 } }).toObject(), roomTypes: [] } as any))
      assert.deepStrictEqual(hotel.processingFee, fee)
      const restaurant: any = plain(presentRestaurant(Restaurant.hydrate({ _id: new Types.ObjectId(), name: { fr: 'R' }, slug: 'r', city: 'K', processingFee: { CDF: 5_700 } }).toObject() as any))
      assert.deepStrictEqual(restaurant.processingFee, fee)
      const [vehicle]: any[] = plain(presentVehicleCards([{ _id: new Types.ObjectId(), make: 'Toyota', model: 'Hilux', sellPrice: { CDF: 1_000_000 }, costPrice: { CDF: 800_000 }, processingFee: { CDF: 5_700 } }]))
      assert.deepStrictEqual(vehicle.processingFee, fee)
      const ride: any = plain(presentPublicCategory({ _id: new Types.ObjectId(), name: { fr: 'B' }, seats: 4, costPerKm: { CDF: 1 }, costPerHour: { CDF: 1 }, processingFee: { CDF: 0 } }))
      assert.ok(!('processingFee' in ride))
      for (const out of [listing, hotel, restaurant, vehicle, ride]) assert.ok(!/cost/i.test(JSON.stringify(out)), JSON.stringify(out))
   })

   console.log(
      failures === 0
         ? '\nAll catalogue checks passed.\n'
         : `\n${failures} catalogue check(s) FAILED.\n`
   )
   process.exit(failures === 0 ? 0 : 1)
}

void main()
