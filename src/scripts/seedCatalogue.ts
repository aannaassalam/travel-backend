/**
 * Full public catalogue for development.
 *
 *   npm run seed:catalogue
 *
 * Generates a realistic volume — bus and flight routes on timetables, cars,
 * activities and properties, plus 16 hotels whose room types carry a nightly
 * price, every one named against a supplier — so the site can be used and
 * judged with a full catalogue rather than a handful of fixtures.
 *
 * Everything is produced from a seeded PRNG, so re-running gives byte-identical
 * data and screenshots stay comparable between runs.
 *
 * SAFETY: this script deletes the catalogue collections. It refuses to run
 * against anything that is not a local database unless SEED_CONFIRM=1 is set
 * explicitly, because "seed the dev data" should never be one stale shell
 * variable away from wiping a live cluster.
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import { LISTING_STATUS, MEAL_PLANS, VERTICALS } from '../constants/domain.constants'
import { Hotel, RatePlan, RoomType } from '../model/hotelModel'
import { Listing } from '../model/listingModel'
import { Supplier } from '../model/supplierModel'
import { usdToFrancs } from './migrateCdfBase'

/* ------------------------------------------------------------------ helpers */

function rng(seed: number) {
   let a = seed >>> 0
   return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
   }
}
const rand = rng(20260801)
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]
/**
 * City-centre coordinates, so a seeded hotel lands in the city it claims.
 *
 * This replaced `between(-11.7, -1.6), between(13.4, 29.3)` — a random point
 * anywhere inside the DRC's bounding box. It produced a "Kinshasa" hotel
 * plotted 1,200 km away in rural Katanga, which looked fine until a map was
 * put on the page and showed empty terrain with no streets.
 */
const CITY_CENTRES: Record<string, { lat: number; lng: number }> = {
   Kinshasa: { lat: -4.4419, lng: 15.2663 },
   Lubumbashi: { lat: -11.6876, lng: 27.5026 },
   Goma: { lat: -1.6585, lng: 29.2206 },
   Bukavu: { lat: -2.5083, lng: 28.8608 },
   Matadi: { lat: -5.8167, lng: 13.45 },
   Kisangani: { lat: 0.5153, lng: 25.19 },
   'Mbuji-Mayi': { lat: -6.136, lng: 23.5898 },
   Kananga: { lat: -5.896, lng: 22.4166 },
   Kolwezi: { lat: -10.7147, lng: 25.4667 },
   Mbandaka: { lat: 0.0487, lng: 18.2603 },
}

/**
 * A point within roughly 3 km of the city centre.
 *
 * Jittered rather than exact so a city's hotels are not stacked on one pixel,
 * but small enough that every one stays inside the built-up area where the map
 * actually has streets to show.
 */
const nearCity = (city: string) => {
   const c = CITY_CENTRES[city] ?? CITY_CENTRES.Kinshasa
   const jitter = () => (Math.random() - 0.5) * 0.055
   return { lat: +(c.lat + jitter()).toFixed(6), lng: +(c.lng + jitter()).toFixed(6) }
}

const between = (a: number, b: number) => a + rand() * (b - a)
const intBetween = (a: number, b: number) => Math.floor(between(a, b + 1))
const chance = (p: number) => rand() < p

/** Dollars → integer minor units (§5): what the catalogue was drawn in. */
const usd = (dollars: number) => Math.round(dollars * 100)

/**
 * Prices are stored in francs only; USD and EUR come from the rates in
 * Settings. The dollar figures drawn here become francs at 2 850 FC, rounded up
 * to the next 100 — as the one-off conversion turned the dollar catalogue.
 */
const francs = (usdMinor: number) => usdToFrancs(usdMinor, 2850)
const money = (usdMinor: number) => ({ CDF: francs(usdMinor) })

/** Localised text. French is required before publish; English ships with it. */
const L = (fr: string, en: string) => ({ fr, en })
const day = (offset: number, hour = 0) => {
   const d = new Date()
   d.setUTCHours(hour, 0, 0, 0)
   d.setUTCDate(d.getUTCDate() + offset)
   return d
}
const slugify = (s: string) =>
   s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

const img = {
   flight: ['/img/flight-1.svg', '/img/flight-2.svg', '/img/flight-3.svg'],
   bus: ['/img/bus-1.svg', '/img/bus-2.svg', '/img/bus-3.svg'],
   car: ['/img/car-1.svg', '/img/car-2.svg', '/img/car-3.svg', '/img/car-4.svg', '/img/car-5.svg'],
   activity: [
      '/img/activity-1.svg',
      '/img/activity-2.svg',
      '/img/activity-3.svg',
      '/img/activity-4.svg',
      '/img/activity-5.svg',
      '/img/activity-6.svg',
   ],
   property: [
      '/img/property-1.svg',
      '/img/property-2.svg',
      '/img/property-3.svg',
      '/img/property-4.svg',
      '/img/property-5.svg',
      '/img/property-6.svg',
      '/img/property-7.svg',
      '/img/property-8.svg',
   ],
   hotel: [
      '/img/hotel-1.svg',
      '/img/hotel-2.svg',
      '/img/hotel-3.svg',
      '/img/hotel-4.svg',
      '/img/hotel-5.svg',
      '/img/hotel-6.svg',
   ],
   room: [
      '/img/room-1.svg',
      '/img/room-2.svg',
      '/img/room-3.svg',
      '/img/room-4.svg',
      '/img/room-5.svg',
      '/img/room-6.svg',
   ],
}
/** Two or three distinct images from a pool, so galleries are never repeats. */
const gallery = (pool: string[], n = 3) => {
   const copy = [...pool]
   const out: string[] = []
   for (let i = 0; i < Math.min(n, copy.length); i++) {
      out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0])
   }
   return out
}

const CITIES = [
   { name: 'Kinshasa', iata: 'FIH', weight: 5 },
   { name: 'Lubumbashi', iata: 'FBM', weight: 4 },
   { name: 'Goma', iata: 'GOM', weight: 3 },
   { name: 'Bukavu', iata: 'BKY', weight: 2 },
   { name: 'Kisangani', iata: 'FKI', weight: 2 },
   { name: 'Matadi', iata: 'MAT', weight: 2 },
   { name: 'Mbuji-Mayi', iata: 'MJM', weight: 2 },
   { name: 'Kananga', iata: 'KGA', weight: 1 },
   { name: 'Kolwezi', iata: 'KWZ', weight: 1 },
   { name: 'Mbandaka', iata: 'MDK', weight: 1 },
   { name: 'Kikwit', iata: 'KKW', weight: 1 },
   { name: 'Bunia', iata: 'BUX', weight: 1 },
] as const

const rating = () => Math.round(between(3.6, 4.9) * 10) / 10
const reviews = () => intBetween(8, 480)

/* ------------------------------------------------------------------ flights */

const CARRIERS = ['Congo Airways', 'Air Kasaï', 'CAA', 'Malu Aviation'] as const
const FLIGHT_TIMES = ['06:30', '08:00', '10:15', '13:00', '15:45', '17:30'] as const

/** n different items, in a stable order. */
const some = <T>(arr: readonly T[], n: number) =>
   [...arr].sort(() => rand() - 0.5).slice(0, n)

/**
 * Bus and flight fares: adult, child (2–12, about three quarters) and baby
 * (under 2), each with its cost — what the agency charges the office.
 */
const fares = (adult: number, babyShare: number) => {
   const child = usd(Math.round((adult / 100) * 0.75))
   const baby = usd(Math.round((adult / 100) * babyShare))
   return {
      costPrice: money(Math.round(adult * 0.78)),
      sellPrice: money(adult),
      childCostPrice: money(Math.round(child * 0.78)),
      childSellPrice: money(child),
      infantCostPrice: money(Math.round(baby * 0.5)),
      infantSellPrice: money(baby),
   }
}

/** Flight routes: one or two airlines on each pair, flying set days of the week. */
function buildFlights() {
   const out: any[] = []
   const routes: [string, string][] = [
      ['Kinshasa', 'Lubumbashi'],
      ['Kinshasa', 'Goma'],
      ['Kinshasa', 'Kisangani'],
      ['Kinshasa', 'Mbuji-Mayi'],
      ['Kinshasa', 'Bukavu'],
      ['Kinshasa', 'Kananga'],
      ['Kinshasa', 'Mbandaka'],
      ['Lubumbashi', 'Kinshasa'],
      ['Lubumbashi', 'Kolwezi'],
      ['Goma', 'Kinshasa'],
      ['Goma', 'Bukavu'],
      ['Kisangani', 'Kinshasa'],
      ['Bukavu', 'Kinshasa'],
      ['Mbuji-Mayi', 'Kinshasa'],
   ]

   for (const [from, to] of routes) {
      for (const carrier of some(CARRIERS, intBetween(1, 2))) {
         const durationMin = intBetween(95, 205)
         const days = some([0, 1, 2, 3, 4, 5, 6], intBetween(3, 5)).sort()
         const weeklyTimes = days.flatMap((d) =>
            some(FLIGHT_TIMES, chance(0.25) ? 2 : 1).map((time) => ({ day: d, time }))
         )
         const adult = usd(Math.round(between(180, 520) / 5) * 5)
         out.push({
            vertical: VERTICALS.FLIGHT,
            title: L(`${from} → ${to}`, `${from} → ${to}`),
            slug: slugify(`${from}-${to}-${carrier}`),
            description: {
               fr: `Vol direct entre ${from} et ${to} opéré par ${carrier}. Bagage en soute inclus, enregistrement en ligne 24 h avant le départ. Choisissez votre date et l'heure du vol.`,
               en: `Direct flight between ${from} and ${to} operated by ${carrier}. Checked bag included, online check-in from 24 h before departure. Choose your date and flight time.`,
            },
            status: LISTING_STATUS.PUBLISHED,
            city: from,
            images: [pick(img.flight), pick(img.flight)],
            supplier: carrier,
            ...fares(adult, 0.1),
            rating: rating(),
            reviewCount: reviews(),
            attributes: {
               destination: to,
               operator: carrier,
               weeklyTimes,
               durationMinutes: durationMin,
               cabin: 'ECONOMY',
               baggage: `1 bagage en soute ${pick([20, 23])} kg + 1 bagage cabine 7 kg`,
               fareRules: 'Non modifiable. Remboursable à 80 % après déduction des frais de dossier.',
            },
         })
      }
   }
   return out
}

/* ---------------------------------------------------------------------- bus */

const BUS_OPERATORS = ['Transco', 'Kasaï Express', 'Kivu Lines', 'Socogetra'] as const
const BUS_CLASSES = ['Standard', 'Climatisé', 'VIP 2+1'] as const
const BUS_TIMES = ['05:30', '06:30', '08:00', '10:00', '13:00', '15:00'] as const

/** Bus routes: two companies on each road, leaving at the same times every day. */
function buildBuses() {
   const out: any[] = []
   const routes: [string, string, string[]][] = [
      ['Kinshasa', 'Matadi', ['Kasangulu', 'Mbanza-Ngungu']],
      ['Kinshasa', 'Kikwit', ['Kenge', 'Masi-Manimba']],
      ['Kinshasa', 'Kisantu', ['Kasangulu']],
      ['Lubumbashi', 'Kolwezi', ['Likasi']],
      ['Lubumbashi', 'Kasumbalesa', []],
      ['Goma', 'Bukavu', ['Sake', 'Minova']],
      ['Kananga', 'Mbuji-Mayi', ['Dimbelenge']],
      ['Kisangani', 'Bunia', ['Nia-Nia']],
   ]

   for (const [from, to, stops] of routes) {
      for (const operator of some(BUS_OPERATORS, 2)) {
         const cls = pick(BUS_CLASSES)
         const hours = intBetween(3, 11)
         const adult = usd(Math.round(between(12, 48)))
         out.push({
            vertical: VERTICALS.BUS,
            title: L(`${from} → ${to}`, `${from} → ${to}`),
            slug: slugify(`${from}-${to}-${operator}`),
            description: {
               fr: `Liaison ${from} – ${to} assurée par ${operator} en bus ${cls.toLowerCase()}. ${
                  stops.length ? `Arrêts à ${stops.join(', ')}. ` : ''
               }Bagage de 20 kg inclus, départ depuis la gare routière. Départs tous les jours.`,
               en: `${from} – ${to} service run by ${operator} on a ${cls.toLowerCase()} coach. ${
                  stops.length ? `Stops at ${stops.join(', ')}. ` : ''
               }20 kg baggage included, departs from the bus terminal. Departures every day.`,
            },
            status: LISTING_STATUS.PUBLISHED,
            city: from,
            images: [pick(img.bus)],
            supplier: operator,
            ...fares(adult, chance(0.5) ? 0 : 0.1),
            rating: rating(),
            reviewCount: reviews(),
            attributes: {
               destination: to,
               operator,
               vehicleClass: cls,
               routeStops: [from, ...stops, to],
               dailyTimes: some(BUS_TIMES, intBetween(2, 3)).sort(),
               durationMinutes: hours * 60,
            },
         })
      }
   }
   return out
}

/* --------------------------------------------------------------------- cars */

const CAR_MODELS = [
   { make: 'Toyota', model: 'Land Cruiser V8', category: '4x4', price: [110, 160] },
   { make: 'Toyota', model: 'Corolla', category: 'Berline', price: [45, 70] },
   { make: 'Toyota', model: 'RAV4', category: 'SUV', price: [70, 100] },
   { make: 'Toyota', model: 'Hiace', category: 'Minibus', price: [95, 140] },
   { make: 'Nissan', model: 'Patrol', category: '4x4', price: [100, 150] },
   { make: 'Hyundai', model: 'H-1', category: 'Minibus', price: [110, 150] },
   { make: 'Mercedes-Benz', model: 'Classe E', category: 'Premium', price: [160, 220] },
   { make: 'Mitsubishi', model: 'Pajero', category: '4x4', price: [95, 135] },
] as const

function buildCars() {
   const out: any[] = []
   const cities = ['Kinshasa', 'Lubumbashi', 'Goma', 'Matadi', 'Kisangani']
   for (const city of cities) {
      for (let v = 0; v < 5; v++) {
         const spec = pick(CAR_MODELS)
         const withDriver = chance(0.55)
         const price = usd(Math.round(between(spec.price[0], spec.price[1]) + (withDriver ? 35 : 0)))
         const total = intBetween(1, 8)
         const sold = chance(0.12) ? total : intBetween(0, Math.max(0, total - 1))
         // Shorter hires cost more by the hour, in whole dollars. Worked out
         // from the 24-hour price rather than drawn, so the rest of the seed
         // stays as it was; every fifth car keeps the 24-hour price only, as
         // cars made before hourly rates have.
         const rate = (share: number) => usd(Math.max(1, Math.round((price / 100) * share)))
         const shorter =
            v === 4
               ? {}
               : {
                    hourlyCostPrice: money(Math.round(rate(1 / 12) * 0.68)),
                    hourlySellPrice: money(rate(1 / 12)),
                    sixHourCostPrice: money(Math.round(rate(0.4) * 0.68)),
                    sixHourSellPrice: money(rate(0.4)),
                    twelveHourCostPrice: money(Math.round(rate(0.65) * 0.68)),
                    twelveHourSellPrice: money(rate(0.65)),
                 }

         out.push({
            vertical: VERTICALS.CAR,
            title: L(
               `${spec.make} ${spec.model} — ${
                  withDriver ? 'avec chauffeur' : 'sans chauffeur'
               }, ${city}`,
               `${spec.make} ${spec.model} — ${
                  withDriver ? 'with driver' : 'self-drive'
               }, ${city}`
            ),
            slug: slugify(`${spec.make}-${spec.model}-${withDriver ? 'chauffeur' : 'libre'}-${city}-${v}`),
            description: {
               fr: `${spec.make} ${spec.model} ${intBetween(2019, 2024)} disponible à ${city}. ${
                  withDriver
                     ? 'Chauffeur expérimenté inclus, connaissant la ville et les axes régionaux.'
                     : 'Location sans chauffeur — permis de conduire international requis.'
               } Carburant et péages à la charge du client.`,
               en: `${spec.make} ${spec.model} ${intBetween(2019, 2024)} available in ${city}. ${
                  withDriver
                     ? 'Experienced driver included, familiar with the city and regional roads.'
                     : 'Self-drive hire — international driving permit required.'
               } Fuel and tolls payable by the customer.`,
            },
            status: sold >= total ? LISTING_STATUS.SOLD_OUT : LISTING_STATUS.PUBLISHED,
            city,
            images: gallery(img.car, 2),
            supplier: `${city} Fleet`,
            costPrice: money(Math.round(price * 0.68)),
            sellPrice: money(price),
            ...shorter,
            quantityTotal: total,
            quantitySold: sold,
            rating: rating(),
            reviewCount: reviews(),
            attributes: {
               make: spec.make,
               model: spec.model,
               year: intBetween(2019, 2024),
               category: spec.category,
               transmission: chance(0.7) ? 'AUTOMATIC' : 'MANUAL',
               withDriver,
               deposit: francs(usd(intBetween(200, 400))),
               mileageLimit: `${intBetween(120, 250)} km / jour`,
               pickupLocations: [`Aéroport de ${city}`, `${city} centre`],
               insuranceTerms: chance(0.6)
                  ? 'Assurance tous risques incluse, franchise 500 $'
                  : 'Assurance au tiers, franchise 800 $',
            },
         })
      }
   }
   return out
}

/* --------------------------------------------------------------- activities */

const ACTIVITIES = [
   {
      title: 'Gorilles des plaines — parc de Kahuzi-Biega',
      city: 'Bukavu',
      minutes: 660,
      price: [420, 520],
      fr: "Journée de pistage des gorilles de plaine de l'Est avec les pisteurs du parc. Permis, guide, transport 4x4 et déjeuner pique-nique inclus.",
      en: 'Full-day eastern lowland gorilla tracking with park rangers. Permit, guide, 4x4 transport and picnic lunch included.',
   },
   {
      title: 'Volcan Nyiragongo — ascension de deux jours',
      city: 'Goma',
      minutes: 1800,
      price: [330, 450],
      fr: 'Ascension guidée jusqu\'au lac de lave, nuit en refuge au sommet. Porteur, refuge, repas chauds et permis inclus.',
      en: 'Guided climb to the lava lake with a night in the summit shelter. Porter, shelter, hot meals and permit included.',
   },
   {
      title: 'Croisière sur le fleuve Congo — coucher de soleil',
      city: 'Kinshasa',
      minutes: 180,
      price: [45, 85],
      fr: 'Trois heures sur le fleuve au départ de la baie de Ngaliema, collation et boisson incluses.',
      en: 'Three hours on the river from Ngaliema bay, snack and a drink included.',
   },
   {
      title: 'Kinshasa à pied — marchés et rumba',
      city: 'Kinshasa',
      minutes: 240,
      price: [35, 60],
      fr: 'Demi-journée à pied dans Gombe et Bandal : marché central, ateliers de sapeurs, pause chez un disquaire de rumba.',
      en: 'Half a day on foot through Gombe and Bandal: central market, sapeur workshops, a stop at a rumba record shop.',
   },
   {
      title: 'Chutes de Zongo — excursion à la journée',
      city: 'Kinshasa',
      minutes: 600,
      price: [80, 130],
      fr: "Excursion vers les chutes de Zongo sur la rivière Inkisi. Transport 4x4, déjeuner et entrée du site inclus.",
      en: 'Day trip to the Zongo falls on the Inkisi river. 4x4 transport, lunch and site entry included.',
   },
   {
      title: 'Parc national de la Garamba — safari 3 jours',
      city: 'Kisangani',
      minutes: 4320,
      price: [1100, 1450],
      fr: 'Trois jours en savane du nord-est : girafes du Congo, éléphants et buffles. Lodge et pension complète inclus.',
      en: 'Three days in the north-eastern savanna: Congo giraffe, elephant and buffalo. Lodge and full board included.',
   },
   {
      title: 'Lac Kivu — journée en bateau et plantation de café',
      city: 'Bukavu',
      minutes: 480,
      price: [70, 120],
      fr: 'Traversée du lac, visite d\'une plantation de café à Idjwi et dégustation. Déjeuner au bord de l\'eau.',
      en: 'Crossing the lake, a coffee plantation visit on Idjwi and a tasting. Lunch by the water.',
   },
   {
      title: 'Réserve de bonobos de Lola ya Bonobo',
      city: 'Kinshasa',
      minutes: 300,
      price: [50, 90],
      fr: "Demi-journée au sanctuaire de bonobos au sud de Kinshasa, avec un soigneur. Transport et entrée inclus.",
      en: 'Half a day at the bonobo sanctuary south of Kinshasa, with a keeper. Transport and entry included.',
   },
   {
      title: 'Mine de cuivre du Katanga — visite industrielle',
      city: 'Lubumbashi',
      minutes: 360,
      price: [90, 140],
      fr: 'Visite encadrée d\'un site minier du Haut-Katanga, avec équipement de sécurité fourni.',
      en: 'Escorted visit to a Haut-Katanga mining site, safety equipment provided.',
   },
   {
      title: 'Descente du fleuve en pirogue — Maluku',
      city: 'Kinshasa',
      minutes: 540,
      price: [60, 110],
      fr: 'Journée en pirogue motorisée depuis Maluku, déjeuner de poisson grillé sur une île du fleuve.',
      en: 'A day in a motorised pirogue from Maluku, grilled fish lunch on a river island.',
   },
] as const

function buildActivities() {
   const out: any[] = []
   for (const a of ACTIVITIES) {
      for (let v = 0; v < 2; v++) {
         const price = usd(Math.round(between(a.price[0], a.price[1])))
         const total = intBetween(4, 30)
         const sold = chance(0.13) ? total : intBetween(0, total - 2)
         out.push({
            vertical: VERTICALS.ACTIVITY,
            title: L(
               v === 0 ? a.title : `${a.title} — départ privé`,
               v === 0 ? a.title : `${a.title} — private departure`
            ),
            slug: slugify(`${a.title}-${v}`),
            description: { fr: a.fr, en: a.en },
            status: sold >= total ? LISTING_STATUS.SOLD_OUT : LISTING_STATUS.PUBLISHED,
            city: a.city,
            images: gallery(img.activity, 3),
            supplier: `${a.city} Tours`,
            costPrice: money(Math.round(price * 0.72)),
            sellPrice: money(v === 0 ? price : Math.round(price * 1.35)),
            quantityTotal: total,
            quantitySold: sold,
            rating: rating(),
            reviewCount: reviews(),
            attributes: {
               durationMinutes: a.minutes,
               minParticipants: v === 0 ? 2 : 1,
               maxParticipants: v === 0 ? intBetween(8, 24) : 6,
               meetingPoint: `Point de rendez-vous communiqué à la réservation — ${a.city}`,
               languages: ['Français', 'Anglais', ...(chance(0.5) ? ['Swahili'] : [])],
               inclusions: ['Guide', 'Transport sur place', 'Eau', ...(a.minutes > 500 ? ['Repas'] : [])],
               exclusions: ['Pourboires', 'Assurance voyage', 'Dépenses personnelles'],
               childPrice: francs(Math.round(price * 0.65)),
            },
         })
      }
   }
   return out
}

/* ----------------------------------------------------------------- property */

const PROPERTY_TYPES = [
   { type: 'HOUSE_SALE', basis: 'TOTAL', fr: 'Maison', price: [95000, 620000] },
   { type: 'LAND_SALE', basis: 'TOTAL', fr: 'Terrain', price: [28000, 240000] },
   { type: 'APARTMENT_RENT', basis: 'PER_MONTH', fr: 'Appartement', price: [800, 4500] },
   { type: 'HOUSE_RENT', basis: 'PER_MONTH', fr: 'Maison', price: [900, 5200] },
   { type: 'LAND_RENT', basis: 'PER_MONTH', fr: 'Terrain', price: [400, 2200] },
] as const

const DISTRICTS: Record<string, string[]> = {
   Kinshasa: ['Gombe', 'Limete', 'Ngaliema', 'Kintambo', 'Lemba', 'Bandalungwa'],
   Lubumbashi: ['Golf', 'Makutano', 'Bel-Air', 'Kiwele'],
   Goma: ['Himbi', 'Katindo', 'Les Volcans'],
   Matadi: ['Ville Basse', 'Soyo', 'Ciné Palace'],
   Bukavu: ['Ibanda', 'Muhumba', 'Nguba'],
}

function buildProperties() {
   const out: any[] = []
   const cities = Object.keys(DISTRICTS)
   for (const city of cities) {
      for (let v = 0; v < 6; v++) {
         const spec = pick(PROPERTY_TYPES)
         const district = pick(DISTRICTS[city])
         const isLand = spec.type.startsWith('LAND')
         const bedrooms = isLand ? undefined : intBetween(2, 6)
         const price = usd(Math.round(between(spec.price[0], spec.price[1]) / 100) * 100)
         const areaSqm = isLand ? undefined : intBetween(85, 520)
         const plotSizeSqm = intBetween(300, 4000)

         const title = isLand
            ? `Terrain de ${plotSizeSqm.toLocaleString('fr-FR')} m² — ${district}, ${city}`
            : `${spec.fr} ${bedrooms} chambres — ${district}, ${city}`
         const titleEn = isLand
            ? `${plotSizeSqm.toLocaleString('en-GB')} m² plot — ${district}, ${city}`
            : `${bedrooms}-bedroom ${spec.fr === 'Maison' ? 'house' : 'apartment'} — ${district}, ${city}`

         out.push({
            vertical: VERTICALS.PROPERTY,
            title: L(title, titleEn),
            slug: slugify(`${title}-${v}`),
            description: {
               fr: isLand
                  ? `Parcelle de ${plotSizeSqm.toLocaleString(
                       'fr-FR'
                    )} m² à ${district}, ${city}. Terrain ${
                       chance(0.6) ? 'plat et viabilisé' : 'en légère pente, à viabiliser'
                    }, accès sur voie ${chance(0.5) ? 'bitumée' : 'carrossable'}. Bornage effectué, plan cadastral disponible.`
                  : `${spec.fr} de ${areaSqm} m² à ${district}, ${city}, sur une parcelle de ${plotSizeSqm.toLocaleString(
                       'fr-FR'
                    )} m². ${bedrooms} chambres, séjour, cuisine équipée${
                       chance(0.5) ? ', groupe électrogène et forage' : ''
                    }. ${
                       spec.basis === 'PER_MONTH'
                          ? 'Charges et gardiennage inclus, bail d\'un an minimum.'
                          : 'Titre foncier disponible chez le notaire.'
                    }`,
               en: isLand
                  ? `A ${plotSizeSqm.toLocaleString('en-GB')} m² plot in ${district}, ${city}. ${
                       chance(0.6) ? 'Flat and serviced' : 'Gently sloping, services to be brought in'
                    }, access from a ${chance(0.5) ? 'tarred' : 'graded'} road. Surveyed, cadastral plan available.`
                  : `${areaSqm} m² ${spec.fr.toLowerCase()} in ${district}, ${city}, on a ${plotSizeSqm.toLocaleString(
                       'en-GB'
                    )} m² plot. ${bedrooms} bedrooms, reception, fitted kitchen${
                       chance(0.5) ? ', generator and borehole' : ''
                    }. ${
                       spec.basis === 'PER_MONTH'
                          ? 'Service charges and security included, one-year minimum lease.'
                          : 'Title deed available at the notary.'
                    }`,
            },
            status: LISTING_STATUS.PUBLISHED,
            city,
            images: gallery(img.property, 3),
            // Property has no inventory quantity and no checkout (§1.1 archetype C).
            costPrice: money(0),
            sellPrice: money(price),
            quantityTotal: 1,
            quantitySold: 0,
            attributes: {
               propertyType: spec.type,
               priceBasis: spec.basis,
               areaSqm,
               plotSizeSqm,
               bedrooms,
               bathrooms: isLand ? undefined : Math.max(1, Math.round((bedrooms ?? 2) * 0.7)),
               features: [
                  ...(isLand
                     ? ['Bornage effectué', 'Plan cadastral']
                     : ['Cuisine équipée', 'Parking']),
                  ...(chance(0.5) ? ['Groupe électrogène'] : []),
                  ...(chance(0.4) ? ['Forage'] : []),
                  ...(chance(0.35) ? ['Piscine'] : []),
                  ...(chance(0.6) ? ['Gardiennage 24 h'] : []),
               ],
               titleDeedStatus: chance(0.75)
                  ? "Certificat d'enregistrement au nom du vendeur"
                  : 'Titre en cours de régularisation',
               availabilityStatus: chance(0.12) ? 'UNDER_OFFER' : 'AVAILABLE',
            },
         })
      }
   }
   return out
}

/* ------------------------------------------------------------------- hotels */

const HOTEL_NAMES = [
   ['Fleuve Congo Riverside', 'Kinshasa', 5],
   ['Résidence Gombe Suites', 'Kinshasa', 4],
   ['Pullman Ngaliema', 'Kinshasa', 5],
   ['Hôtel Béatrice', 'Kinshasa', 4],
   ['Kin Plaza Arjaan', 'Kinshasa', 4],
   ['Sultani River Hotel', 'Kinshasa', 4],
   ['Katanga Business Hotel', 'Lubumbashi', 4],
   ['Park Hotel Lubumbashi', 'Lubumbashi', 4],
   ['Lubum Residence', 'Lubumbashi', 3],
   ['Lac Kivu Lodge', 'Goma', 4],
   ['Serena Goma', 'Goma', 5],
   ['Ihusi Hotel', 'Goma', 4],
   ['Orchid Safari Club', 'Bukavu', 4],
   ['Hôtel du Port', 'Matadi', 3],
   ['Tshopo River Hotel', 'Kisangani', 3],
   ['Palm Beach Mbandaka', 'Mbandaka', 3],
] as const

const AMENITIES = [
   'Wifi gratuit',
   'Piscine',
   'Restaurant',
   'Salle de sport',
   'Navette aéroport',
   'Climatisation',
   'Groupe électrogène',
   'Parking sécurisé',
   'Blanchisserie',
   'Salles de réunion',
   'Bar',
   'Vue lac',
   'Jardin',
   'Petit-déjeuner inclus',
]

const ROOM_TEMPLATES = [
   { name: 'Chambre Standard', beds: '1 lit double', adults: 2, size: [20, 28], mult: 1 },
   { name: 'Chambre Supérieure', beds: '1 lit queen size', adults: 2, size: [26, 34], mult: 1.28 },
   { name: 'Chambre Deluxe', beds: '1 lit king size', adults: 3, size: [32, 42], mult: 1.55 },
   { name: 'Suite Junior', beds: '1 lit king size + canapé-lit', adults: 3, size: [45, 62], mult: 2.1 },
   { name: 'Suite Exécutive', beds: '1 lit king size', adults: 4, size: [60, 90], mult: 2.9 },
] as const

async function buildHotels(supplierId: (name: string) => Promise<unknown>) {
   const hotelDocs: any[] = []
   for (const [name, city, stars] of HOTEL_NAMES) {
      const amenityCount = intBetween(6, 10)
      const amenities = [...AMENITIES].sort(() => rand() - 0.5).slice(0, amenityCount)
      hotelDocs.push({
         name: L(name, name),
         slug: slugify(`${name}-${city}`),
         description: {
            fr: `${name} est un établissement ${stars} étoiles situé à ${city}. ${
               amenities.includes('Piscine') ? 'Piscine extérieure, ' : ''
            }restaurant sur place et personnel francophone. Groupe électrogène et forage : ni coupure d'électricité ni coupure d'eau.`,
            en: `${name} is a ${stars}-star property in ${city}. ${
               amenities.includes('Piscine') ? 'Outdoor pool, ' : ''
            }on-site restaurant and French-speaking staff. Generator and borehole: neither power nor water cuts.`,
         },
         status: LISTING_STATUS.PUBLISHED,
         stars,
         address: `${pick(DISTRICTS[city] ?? ['Centre-ville'])}, ${city}`,
         city,
         country: 'CD',
         geo: nearCity(city),
         amenities,
         images: gallery(img.hotel, 2).concat(gallery(img.room, 2)),
         supplier: await supplierId(`${name} direct`),
         checkInTime: '14:00',
         checkOutTime: '11:00',
         policies:
            "Arrivée à partir de 14 h 00, départ avant 11 h 00. Une pièce d'identité est demandée à l'enregistrement. Remboursable à 80 % après déduction des frais de dossier.",
         rating: rating(),
         reviewCount: reviews(),
      })
   }

   const hotels = await Hotel.create(hotelDocs)

   const roomDocs: any[] = []
   const baseByHotel = new Map<string, number>()
   for (const h of hotels) {
      const base = between(45, 210) * (h.stars / 4)
      baseByHotel.set(String(h._id), base)
      const templates = [...ROOM_TEMPLATES].slice(0, intBetween(2, 4))
      for (const tpl of templates) {
         // One nightly price per room type, for every night.
         const sell = usd(Math.round((base * tpl.mult) / 5) * 5)
         roomDocs.push({
            costPrice: money(Math.round(sell * 0.72)),
            sellPrice: money(sell),
            mealPlan: tpl.mult > 1.5 ? MEAL_PLANS.HALF_BOARD : MEAL_PLANS.BREAKFAST,
            hotel: h._id,
            name: L(tpl.name, tpl.name),
            description: {
               fr: `${Math.round(between(tpl.size[0], tpl.size[1]))} m², ${tpl.beds.toLowerCase()}, climatisation et bureau.`,
               en: `${Math.round(between(tpl.size[0], tpl.size[1]))} m², ${tpl.beds.toLowerCase()}, air conditioning and a desk.`,
            },
            maxAdults: tpl.adults,
            maxChildren: tpl.adults > 2 ? 2 : 1,
            beds: tpl.beds,
            amenities: ['Climatisation', 'Wifi', 'Télévision', ...(tpl.mult > 1.5 ? ['Minibar'] : [])],
            images: gallery(img.room, 2),
            sizeSqm: Math.round(between(tpl.size[0], tpl.size[1])),
            status: LISTING_STATUS.PUBLISHED,
         })
      }
   }
   const rooms = await RoomType.create(roomDocs)

   return { hotels: hotels.length, rooms: rooms.length }
}

/* --------------------------------------------------------------------- main */

const run = async () => {
   const uri = buildMongoUri()
   const isLocal = /(localhost|127\.0\.0\.1)/.test(uri)
   if (!isLocal && process.env.SEED_CONFIRM !== '1') {
      throw new Error(
         'Refusing to seed a non-local database. This script deletes the catalogue.\n' +
            'Point MONGODB_URI at a local instance, or set SEED_CONFIRM=1 if you really mean it.'
      )
   }
   if (process.env.NODE_ENV === 'production') {
      throw new Error('seed:catalogue refuses to run with NODE_ENV=production')
   }

   await mongoose.connect(uri)
   console.log('connected:', mongoose.connection.name)

   await Promise.all([
      Listing.deleteMany({}),
      Hotel.deleteMany({}),
      RoomType.deleteMany({}),
      RatePlan.deleteMany({}),
   ])

   /**
    * Every supplier named below, as a record with demo contact details: made
    * once per name, kept across runs (other data may already point at it).
    */
   const made = new Map<string, unknown>()
   const supplierId = async (name: string) => {
      if (!made.has(name)) {
         const n = made.size + 1
         const handle = slugify(name)
         const supplier = await Supplier.findOneAndUpdate(
            { name },
            {
               $setOnInsert: {
                  name,
                  phone: `+24381000${String(n).padStart(4, '0')}`,
                  email: `reservations@${handle}.example`,
                  contactName: pick(['Jean Mukendi', 'Grâce Kabila', 'Patrick Ilunga', 'Sarah Mbuyi']),
                  address: `${pick(['Avenue du Commerce', 'Boulevard du 30 Juin', 'Avenue Kasa-Vubu'])}, ${n}`,
               },
            },
            { upsert: true, new: true }
         )
         made.set(name, supplier._id)
      }
      return made.get(name)
   }

   const listings = [
      ...buildFlights(),
      ...buildBuses(),
      ...buildCars(),
      ...buildActivities(),
      ...buildProperties(),
   ]
   for (const l of listings) if (l.supplier) l.supplier = await supplierId(l.supplier)
   await Listing.insertMany(listings, { ordered: false })

   const hotelStats = await buildHotels(supplierId)

   const byVertical = listings.reduce<Record<string, number>>((acc, l) => {
      acc[l.vertical] = (acc[l.vertical] ?? 0) + 1
      return acc
   }, {})

   console.log('seeded listings:', byVertical, 'total', listings.length)
   console.log('seeded hotels:', hotelStats)
   await mongoose.disconnect()
}

run().catch((err) => {
   console.error(err.message)
   process.exit(1)
})
