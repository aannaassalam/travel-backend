/**
 * Vehicles for sale for development: the common list of types, specs and
 * accessories, three parkings (Kinshasa, Lubumbashi, Goma) and 15 vehicles.
 *
 *   npm run seed:vehicle-sales
 *
 * Touches only `parkings` and `salevehicles` (emptied first) and adds what is
 * missing to `vehicletypes`, `vehiclespecs` and `vehicleaccessories`.
 *
 * SAFETY: refuses to run against anything that is not a local database unless
 * SEED_CONFIRM=1 is set explicitly, as seed:restaurants.
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import { LISTING_STATUS } from '../constants/domain.constants'
import {
   nextStockRef,
   Parking,
   SaleVehicle,
   VehicleAccessory,
   VehicleSpec,
   VehicleType,
} from '../model/vehicleSaleModel'
import { addStarterCatalogue } from '../services/vehicleSale.service'
import { usdToFrancs } from './migrateCdfBase'

/** Francs only, from a dollar figure at 2 850 FC, rounded up to the next 100. */
const fc = (dollars: number) => usdToFrancs(Math.round(dollars * 100), 2850)

/** Placeholder pictures already in the website (public/img). */
const IMAGES = ['/img/car-1.svg', '/img/car-2.svg', '/img/car-3.svg', '/img/car-4.svg', '/img/car-5.svg']

const PARKINGS = [
   {
      slug: 'parking-gombe-kinshasa',
      fr: 'Parking Gombe',
      en: 'Gombe car park',
      city: 'Kinshasa',
      address: '45, boulevard du 30 Juin, Gombe',
      geo: { lat: -4.3054, lng: 15.3108 },
      phone: '+243810001101',
      hoursFr: 'Lun–Sam 8h00–18h00',
      hoursEn: 'Mon–Sat 8am–6pm',
      descFr: 'Notre parking du centre-ville : berlines, SUV et minibus, essai sur rendez-vous.',
      descEn: 'Our city-centre car park: saloons, SUVs and minibuses, test drives by appointment.',
      types: ['berline', 'suv', 'pick-up', 'citadine', 'monospace', 'minibus'],
   },
   {
      slug: 'parking-centre-lubumbashi',
      fr: 'Parking Lubumbashi Centre',
      en: 'Lubumbashi Centre car park',
      city: 'Lubumbashi',
      address: '112, avenue Mama Yemo',
      geo: { lat: -11.6609, lng: 27.4794 },
      phone: '+243810001102',
      hoursFr: 'Lun–Ven 8h00–17h00, Sam 9h00–13h00',
      hoursEn: 'Mon–Fri 8am–5pm, Sat 9am–1pm',
      descFr: 'Véhicules de chantier et 4x4 pour le Katanga : pick-up, camions, bus.',
      descEn: '4x4s and work vehicles for Katanga: pickups, trucks, buses.',
      types: ['suv', 'pick-up', 'camion', 'bus', 'berline'],
   },
   {
      slug: 'parking-lac-goma',
      fr: 'Parking du Lac',
      en: 'Lakeside car park',
      city: 'Goma',
      address: '8, boulevard Kanyamuhanga',
      geo: { lat: -1.6792, lng: 29.2228 },
      phone: '+243810001103',
      hoursFr: 'Lun–Sam 8h30–17h30',
      hoursEn: 'Mon–Sat 8:30am–5:30pm',
      descFr: 'Tout-terrain, pick-up et motos, prêts pour les routes du Kivu.',
      descEn: 'Off-roaders, pickups and motorcycles, ready for the Kivu roads.',
      types: ['suv', 'pick-up', 'moto', 'minibus', 'break'],
   },
]

type Car = {
   parking: number
   type: string
   make: string
   model: string
   year: number
   km: number
   condition?: 'NEW' | 'USED'
   colour: string
   sell: number
   cost: number
   /** Old price, for a running promotion. */
   was?: number
   titleFr?: string
   choices: Record<string, string>
   numbers: Record<string, number>
   accessories: string[]
}

const BASIC = ['climatisation', 'direction-assistee', 'vitres-electriques', 'abs', 'airbags']
const RICH = [...BASIC, 'verrouillage-centralise', 'camera-de-recul', 'radar-de-recul', 'gps', 'bluetooth', 'ecran-tactile', 'regulateur-de-vitesse']
const auto = (fuel: string, drive = '2-roues-motrices', wheel = 'gauche') => ({ boite: 'automatique', carburant: fuel, transmission: drive, volant: wheel })
const manual = (fuel: string, drive = '2-roues-motrices', wheel = 'gauche') => ({ boite: 'manuelle', carburant: fuel, transmission: drive, volant: wheel })
const sizes = (cc: number, seats: number, doors: number, hp: number) => ({ cylindree: cc, places: seats, portes: doors, puissance: hp })

const CARS: Car[] = [
   { parking: 0, type: 'berline', make: 'Toyota', model: 'Corolla', year: 2016, km: 98_000, colour: 'Blanc', sell: 9_500, cost: 7_800, choices: auto('essence'), numbers: sizes(1800, 5, 4, 140), accessories: [...BASIC, 'bluetooth'] },
   { parking: 0, type: 'suv', make: 'Toyota', model: 'RAV4', year: 2019, km: 62_000, colour: 'Gris', sell: 24_000, cost: 20_500, was: 26_000, choices: auto('essence', 'integrale'), numbers: sizes(2500, 5, 5, 203), accessories: RICH },
   { parking: 0, type: 'suv', make: 'Hyundai', model: 'Tucson', year: 2021, km: 15, condition: 'NEW', colour: 'Noir', sell: 29_000, cost: 25_000, choices: auto('essence'), numbers: sizes(2000, 5, 5, 156), accessories: [...RICH, 'demarrage-sans-cle', 'jantes-alliage'] },
   { parking: 0, type: 'minibus', make: 'Toyota', model: 'Hiace', year: 2015, km: 210_000, colour: 'Blanc', sell: 18_500, cost: 15_000, choices: manual('diesel'), numbers: sizes(2500, 15, 4, 102), accessories: ['climatisation', 'direction-assistee'] },
   { parking: 0, type: 'citadine', make: 'Suzuki', model: 'Swift', year: 2018, km: 54_000, colour: 'Rouge', sell: 7_200, cost: 5_900, choices: manual('essence'), numbers: sizes(1200, 5, 5, 83), accessories: ['climatisation', 'direction-assistee', 'abs'] },
   { parking: 0, type: 'monospace', make: 'Toyota', model: 'Noah', year: 2014, km: 132_000, colour: 'Argent', sell: 8_900, cost: 7_100, choices: auto('essence', '2-roues-motrices', 'droite'), numbers: sizes(2000, 8, 5, 152), accessories: [...BASIC, 'camera-de-recul'] },
   { parking: 1, type: 'suv', make: 'Toyota', model: 'Land Cruiser', year: 2017, km: 145_000, colour: 'Blanc', sell: 48_000, cost: 41_000, choices: auto('diesel', '4x4'), numbers: sizes(4500, 7, 5, 272), accessories: [...RICH, 'sieges-cuir', 'treuil', 'attelage'] },
   { parking: 1, type: 'pick-up', make: 'Toyota', model: 'Hilux', year: 2020, km: 88_000, colour: 'Blanc', sell: 31_000, cost: 26_500, was: 33_500, choices: manual('diesel', '4x4'), numbers: sizes(2800, 5, 4, 204), accessories: [...BASIC, 'attelage'] },
   { parking: 1, type: 'camion', make: 'Mitsubishi', model: 'Fuso Canter', year: 2016, km: 190_000, colour: 'Bleu', sell: 27_000, cost: 22_000, choices: manual('diesel'), numbers: sizes(4900, 3, 2, 150), accessories: ['direction-assistee'] },
   { parking: 1, type: 'berline', make: 'Mercedes-Benz', model: 'Classe C', year: 2018, km: 71_000, colour: 'Noir', sell: 26_500, cost: 22_800, titleFr: 'Mercedes-Benz C 200 Avantgarde', choices: auto('essence'), numbers: sizes(2000, 5, 4, 184), accessories: [...RICH, 'sieges-cuir', 'toit-ouvrant', 'jantes-alliage'] },
   { parking: 1, type: 'bus', make: 'Toyota', model: 'Coaster', year: 2013, km: 260_000, colour: 'Blanc', sell: 34_000, cost: 28_500, choices: manual('diesel'), numbers: sizes(4200, 29, 2, 136), accessories: ['climatisation', 'direction-assistee'] },
   { parking: 2, type: 'suv', make: 'Toyota', model: 'Land Cruiser Prado', year: 2015, km: 160_000, colour: 'Gris', sell: 27_500, cost: 23_000, choices: auto('diesel', '4x4'), numbers: sizes(3000, 7, 5, 173), accessories: [...BASIC, 'gps', 'treuil'] },
   { parking: 2, type: 'pick-up', make: 'Nissan', model: 'Navara', year: 2019, km: 92_000, colour: 'Blanc', sell: 23_000, cost: 19_500, choices: manual('diesel', '4x4'), numbers: sizes(2500, 5, 4, 190), accessories: [...BASIC, 'bluetooth', 'attelage'] },
   { parking: 2, type: 'moto', make: 'Honda', model: 'XR150L', year: 2023, km: 0, condition: 'NEW', colour: 'Rouge', sell: 2_400, cost: 1_900, choices: manual('essence'), numbers: { cylindree: 150, places: 2, puissance: 13 }, accessories: [] },
   { parking: 2, type: 'break', make: 'Toyota', model: 'Corolla Fielder', year: 2014, km: 120_000, colour: 'Bleu', sell: 8_200, cost: 6_700, choices: auto('hybride', '2-roues-motrices', 'droite'), numbers: sizes(1500, 5, 5, 100), accessories: BASIC },
]

const run = async () => {
   const uri = buildMongoUri()
   const isLocal = /(localhost|127\.0\.0\.1)/.test(uri)
   if (!isLocal && process.env.SEED_CONFIRM !== '1') {
      console.error(
         'Refusing to seed a non-local database.\n' +
            'Point MONGODB_URI at a local instance, or set SEED_CONFIRM=1 if you really mean it.'
      )
      process.exit(1)
   }

   await mongoose.connect(uri)
   console.log('connected:', mongoose.connection.name)

   const added = await addStarterCatalogue()
   const [types, specs, accessories] = await Promise.all([VehicleType.find(), VehicleSpec.find(), VehicleAccessory.find()])
   const typeId = new Map(types.map((t) => [t.slug, t._id]))
   const spec = new Map(specs.map((s) => [s.key, s]))
   const accessoryId = new Map(accessories.map((a) => [a.key, a._id]))

   await Promise.all([Parking.deleteMany({}), SaleVehicle.deleteMany({})])

   const parkings = []
   for (const p of PARKINGS) {
      parkings.push(
         await Parking.create({
            name: { fr: p.fr, en: p.en },
            slug: p.slug,
            city: p.city,
            address: p.address,
            geo: p.geo,
            phone: p.phone,
            openingHours: { fr: p.hoursFr, en: p.hoursEn },
            description: { fr: p.descFr, en: p.descEn },
            images: [IMAGES[parkings.length]],
            vehicleTypes: p.types.map((t) => typeId.get(t)!),
            status: LISTING_STATUS.PUBLISHED,
         })
      )
   }

   // A running promotion ends in 30 days.
   const promoEnds = new Date(Date.now() + 30 * 86_400_000)
   promoEnds.setUTCHours(0, 0, 0, 0)

   for (const [i, c] of CARS.entries()) {
      await SaleVehicle.create({
         parking: parkings[c.parking]._id,
         vehicleType: typeId.get(c.type)!,
         make: c.make,
         model: c.model,
         year: c.year,
         mileageKm: c.km,
         condition: c.condition ?? 'USED',
         colour: c.colour,
         title: c.titleFr ? { fr: c.titleFr, en: c.titleFr } : undefined,
         description: {
            fr: `${c.make} ${c.model} ${c.year}, ${c.km.toLocaleString('fr-FR')} km, entretien suivi. À voir au ${PARKINGS[c.parking].fr}.`,
            en: `${c.make} ${c.model} ${c.year}, ${c.km.toLocaleString('en-GB')} km, full service history. See it at ${PARKINGS[c.parking].en}.`,
         },
         stockRef: await nextStockRef(),
         vin: `SEED${String(i + 1).padStart(13, '0')}`,
         costPrice: { CDF: fc(c.cost) },
         sellPrice: { CDF: fc(c.sell) },
         ...(c.was ? { promoCompareAtPrice: { CDF: fc(c.was) }, promoEndsAt: promoEnds } : {}),
         images: [IMAGES[i % IMAGES.length], IMAGES[(i + 1) % IMAGES.length], IMAGES[(i + 2) % IMAGES.length]],
         specs: [
            ...Object.entries(c.choices).map(([key, choice]) => ({ spec: spec.get(key)!._id, choice })),
            ...Object.entries(c.numbers).map(([key, number]) => ({ spec: spec.get(key)!._id, number })),
         ],
         accessories: c.accessories.map((k) => accessoryId.get(k)!),
         status: LISTING_STATUS.PUBLISHED,
      })
   }

   console.log(
      `common list added: ${JSON.stringify(added)}; parkings: ${parkings.length}, vehicles: ${CARS.length}`
   )
   await mongoose.disconnect()
}

run().catch((err) => {
   console.error(err.message)
   process.exit(1)
})
