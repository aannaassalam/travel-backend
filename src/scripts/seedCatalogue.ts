/**
 * Full public catalogue for development.
 *
 *   npm run seed:catalogue
 *
 * Generates a realistic volume — roughly 160 listings across the five sellable
 * verticals plus 16 hotels with room types and a rolling 120 nights of rate
 * plans — so the site can be used and judged with a full catalogue rather than
 * a handful of fixtures.
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
const between = (a: number, b: number) => a + rand() * (b - a)
const intBetween = (a: number, b: number) => Math.floor(between(a, b + 1))
const chance = (p: number) => rand() < p

/** Dollars → integer minor units (§5). */
const usd = (dollars: number) => Math.round(dollars * 100)

/**
 * Prices are per-currency and explicit — never converted at read time. An
 * administrator would type all three; the seed derives CDF and EUR once, at
 * indicative rates, and rounds each to a unit that currency is actually quoted
 * in (CDF to 500 F, EUR to 50 cents).
 */
const money = (usdMinor: number) => ({
   USD: usdMinor,
   CDF: Math.round(((usdMinor / 100) * 2870) / 500) * 500,
   EUR: Math.round(((usdMinor * 0.92) / 50)) * 50,
})

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
      const origin = CITIES.find((c) => c.name === from)!
      const dest = CITIES.find((c) => c.name === to)!

      for (let variant = 0; variant < 4; variant++) {
         const carrier = pick(CARRIERS)
         const cabin = variant === 3 ? 'BUSINESS' : 'ECONOMY'
         const isReturn = variant % 2 === 0
         const depOffset = intBetween(4, 70)
         const durationMin = intBetween(95, 205)
         const depAt = day(depOffset, intBetween(6, 17))
         const arrAt = new Date(+depAt + durationMin * 60000)
         const flightNo = `${carrier === 'Congo Airways' ? '8Z' : carrier === 'CAA' ? 'BU' : 'QC'} ${intBetween(
            100,
            899
         )}`

         const base = cabin === 'BUSINESS' ? between(620, 980) : between(180, 520)
         const price = usd(Math.round((isReturn ? base * 1.75 : base) / 5) * 5)

         const segments: any[] = [
            {
               carrier,
               flightNumber: flightNo,
               origin: origin.iata,
               destination: dest.iata,
               departsAt: depAt,
               arrivesAt: arrAt,
            },
         ]
         if (isReturn) {
            const backAt = day(depOffset + intBetween(3, 14), intBetween(9, 19))
            segments.push({
               carrier,
               flightNumber: `${flightNo.split(' ')[0]} ${intBetween(100, 899)}`,
               origin: dest.iata,
               destination: origin.iata,
               departsAt: backAt,
               arrivesAt: new Date(+backAt + durationMin * 60000),
            })
         }

         // Roughly one in seven is deliberately sold out: §1 says the empty
         // state is the most-used screen, so it has to be reachable by
         // ordinary browsing, not only by a contrived search.
         const total = intBetween(4, 24)
         const sold = chance(0.14) ? total : intBetween(0, total - 2)

         const title = `${from} → ${to}, ${
            isReturn ? 'aller-retour' : 'aller simple'
         }${cabin === 'BUSINESS' ? ', classe Affaires' : ''}`
         const titleEn = `${from} → ${to}, ${
            isReturn ? 'return' : 'one way'
         }${cabin === 'BUSINESS' ? ', Business class' : ''}`

         out.push({
            vertical: VERTICALS.FLIGHT,
            title: L(title, titleEn),
            slug: slugify(`${from}-${to}-${isReturn ? 'ar' : 'as'}-${cabin}-${variant}-${depOffset}`),
            description: {
               fr: `Vol ${
                  segments.length > 1 ? 'aller-retour' : 'direct'
               } entre ${from} et ${to} opéré par ${carrier}. ${
                  cabin === 'BUSINESS'
                     ? 'Classe Affaires : embarquement prioritaire, 32 kg de bagages et accès au salon.'
                     : 'Bagage en soute inclus, enregistrement en ligne 24 h avant le départ.'
               } Places achetées à l'avance : le prix ne bouge pas après réservation.`,
               en: `${
                  segments.length > 1 ? 'Return' : 'Direct'
               } flight between ${from} and ${to} operated by ${carrier}. ${
                  cabin === 'BUSINESS'
                     ? 'Business class: priority boarding, 32 kg baggage and lounge access.'
                     : 'Checked bag included, online check-in from 24 h before departure.'
               } Seats bought in advance: the price does not move after booking.`,
            },
            status: sold >= total ? LISTING_STATUS.SOLD_OUT : LISTING_STATUS.PUBLISHED,
            city: from,
            images: [pick(img.flight), pick(img.flight)],
            supplier: carrier,
            costPrice: money(Math.round(price * 0.78)),
            sellPrice: money(price),
            quantityTotal: total,
            quantitySold: sold,
            quantityHeld: 0,
            validUntil: depAt,
            rating: rating(),
            reviewCount: reviews(),
            attributes: {
               tripType: isReturn ? 'RETURN' : 'ONE_WAY',
               cabin,
               baggage:
                  cabin === 'BUSINESS'
                     ? '2 bagages en soute 32 kg + salon'
                     : `1 bagage en soute ${pick([20, 23])} kg + 1 bagage cabine 7 kg`,
               fareRules: 'Non modifiable. Non remboursable.',
               segments,
            },
         })
      }
   }
   return out
}

/* ---------------------------------------------------------------------- bus */

const BUS_OPERATORS = ['Transco', 'Kasaï Express', 'Kivu Lines', 'Socogetra'] as const
const BUS_CLASSES = ['Standard', 'Climatisé', 'VIP 2+1'] as const

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
      for (let v = 0; v < 4; v++) {
         const operator = pick(BUS_OPERATORS)
         const cls = pick(BUS_CLASSES)
         const offset = intBetween(2, 40)
         const depAt = day(offset, intBetween(5, 15))
         const hours = intBetween(3, 11)
         const total = intBetween(12, 56)
         const sold = chance(0.1) ? total : intBetween(0, total - 4)
         const price = usd(Math.round(between(12, 48)))

         out.push({
            vertical: VERTICALS.BUS,
            title: L(`${from} → ${to}, ${operator}`, `${from} → ${to}, ${operator}`),
            slug: slugify(`${from}-${to}-${operator}-${v}-${offset}`),
            description: {
               fr: `Liaison ${from} – ${to} assurée par ${operator} en bus ${cls.toLowerCase()}. ${
                  stops.length ? `Arrêts à ${stops.join(', ')}. ` : ''
               }Bagage de 20 kg inclus, départ depuis la gare routière.`,
               en: `${from} – ${to} service run by ${operator} on a ${cls.toLowerCase()} coach. ${
                  stops.length ? `Stops at ${stops.join(', ')}. ` : ''
               }20 kg baggage included, departs from the bus terminal.`,
            },
            status: sold >= total ? LISTING_STATUS.SOLD_OUT : LISTING_STATUS.PUBLISHED,
            city: from,
            images: [pick(img.bus)],
            supplier: operator,
            costPrice: money(Math.round(price * 0.7)),
            sellPrice: money(price),
            quantityTotal: total,
            quantitySold: sold,
            validUntil: depAt,
            rating: rating(),
            reviewCount: reviews(),
            attributes: {
               operator,
               vehicleClass: cls,
               routeStops: [from, ...stops, to],
               seatsOrCapacity: total,
               departsAt: depAt,
               arrivesAt: new Date(+depAt + hours * 3600000),
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
               deposit: usd(intBetween(200, 400)),
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
               childPrice: Math.round(price * 0.65),
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

/** A rolling window of nightly rates — the unit that actually sells (§5.2). */
const NIGHTS = 120

async function buildHotels() {
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
         geo: { lat: between(-11.7, -1.6), lng: between(13.4, 29.3) },
         amenities,
         images: gallery(img.hotel, 2).concat(gallery(img.room, 2)),
         supplier: `${name} direct`,
         checkInTime: '14:00',
         checkOutTime: '11:00',
         policies:
            "Arrivée à partir de 14 h 00, départ avant 11 h 00. Une pièce d'identité est demandée à l'enregistrement. Réservation définitive et non remboursable.",
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
         roomDocs.push({
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

   // Nightly rate plans. Weekends cost more, and a scattering of nights is
   // fully sold so the availability logic has something real to compute.
   const plans: any[] = []
   for (const room of rooms) {
      const base = baseByHotel.get(String(room.hotel)) ?? 90
      // `create()` with an array widens the document type here; the name is a
      // plain string on the schema.
      const roomName = String((room as any).name)
      const tpl = ROOM_TEMPLATES.find((t) => t.name === roomName) ?? ROOM_TEMPLATES[0]
      const allotment = intBetween(2, 9)
      for (let n = 0; n < NIGHTS; n++) {
         const date = day(n)
         const weekend = [5, 6].includes(date.getUTCDay())
         const nightly = base * tpl.mult * (weekend ? 1.15 : 1) * between(0.95, 1.08)
         const sell = usd(Math.round(nightly / 5) * 5)
         const sold = chance(0.08) ? allotment : intBetween(0, allotment)
         plans.push({
            hotel: room.hotel,
            roomType: room._id,
            date,
            costPrice: money(Math.round(sell * 0.72)),
            sellPrice: money(sell),
            allotment,
            sold,
            held: 0,
            mealPlan: tpl.mult > 1.5 ? MEAL_PLANS.HALF_BOARD : MEAL_PLANS.BREAKFAST,
            blocked: false,
         })
      }
   }
   await RatePlan.insertMany(plans, { ordered: false })

   return { hotels: hotels.length, rooms: rooms.length, plans: plans.length }
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

   const listings = [
      ...buildFlights(),
      ...buildBuses(),
      ...buildCars(),
      ...buildActivities(),
      ...buildProperties(),
   ]
   await Listing.insertMany(listings, { ordered: false })

   const hotelStats = await buildHotels()

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
