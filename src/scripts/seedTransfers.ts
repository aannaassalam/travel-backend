/**
 * Demo fleet for the transfers module.
 *
 *   npm run seed:transfers        (also run by seed:demo)
 *
 * Three vehicle categories with their prices, the usual pick-up points of
 * Kinshasa, Lubumbashi and Goma, and two cars with two drivers in each city —
 * enough to quote, book, assign and drive a ride end to end on a local
 * database. The three cities are marked as serving transfers, with their
 * centre for the place search.
 *
 * SAFETY: it replaces the fleet and every ride. Same guard as seed:catalogue —
 * a non-local database needs SEED_CONFIRM=1.
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import { VERTICALS } from '../constants/domain.constants'
import { hashPassword } from '../middleware/customerAuth'
import { Driver } from '../model/driverModel'
import { Location } from '../model/locationModel'
import { Ride } from '../model/rideModel'
import { PlaceKind, TransferPlace } from '../model/transferPlaceModel'
import { VehicleCategory } from '../model/vehicleCategoryModel'
import { Vehicle } from '../model/vehicleModel'

/** For local testing only: every demo driver signs in with it. */
export const DEMO_DRIVER_PASSWORD = 'Chauffeur-2026!'

const CITIES: Record<string, { lat: number; lng: number; sortOrder: number }> = {
   Kinshasa: { lat: -4.4419, lng: 15.2663, sortOrder: 1 },
   Lubumbashi: { lat: -11.6876, lng: 27.5026, sortOrder: 2 },
   Goma: { lat: -1.6585, lng: 29.2206, sortOrder: 3 },
}

const CATEGORIES = [
   {
      name: { fr: 'Berline', en: 'Sedan' },
      description: { fr: 'Confortable pour 3 passagers et 2 valises.', en: 'Comfortable for 3 passengers and 2 suitcases.' },
      seats: 3,
      luggage: '2 valises',
      pricePerKm: { CDF: 1_800 },
      pricePerHour: { CDF: 25_000 },
      minimumFare: { CDF: 15_000 },
      costPerKm: { CDF: 1_100 },
      costPerHour: { CDF: 15_000 },
      sortOrder: 1,
   },
   {
      name: { fr: 'SUV', en: 'SUV' },
      description: { fr: '4×4 spacieux, 5 passagers, routes difficiles.', en: 'Roomy 4×4, 5 passengers, rough roads.' },
      seats: 5,
      luggage: '4 valises',
      pricePerKm: { CDF: 2_500 },
      pricePerHour: { CDF: 35_000 },
      minimumFare: { CDF: 20_000 },
      costPerKm: { CDF: 1_600 },
      costPerHour: { CDF: 22_000 },
      sortOrder: 2,
   },
   {
      name: { fr: 'Minibus', en: 'Minibus' },
      description: { fr: 'Jusqu’à 14 passagers, groupes et délégations.', en: 'Up to 14 passengers, groups and delegations.' },
      seats: 14,
      luggage: '14 valises',
      pricePerKm: { CDF: 4_000 },
      pricePerHour: { CDF: 60_000 },
      minimumFare: { CDF: 40_000 },
      costPerKm: { CDF: 2_600 },
      costPerHour: { CDF: 40_000 },
      sortOrder: 3,
   },
]

const PLACES: { city: string; fr: string; en: string; kind: PlaceKind; lat: number; lng: number }[] = [
   { city: 'Kinshasa', fr: 'Aéroport international de Ndjili', en: 'Ndjili International Airport', kind: 'AIRPORT', lat: -4.3857, lng: 15.4446 },
   { city: 'Kinshasa', fr: 'Hôtel Memling', en: 'Memling Hotel', kind: 'HOTEL', lat: -4.3049, lng: 15.3151 },
   { city: 'Kinshasa', fr: 'Pullman Kinshasa Grand Hôtel', en: 'Pullman Kinshasa Grand Hotel', kind: 'HOTEL', lat: -4.2994, lng: 15.2914 },
   { city: 'Kinshasa', fr: 'Gare centrale de Kinshasa', en: 'Kinshasa Central Station', kind: 'STATION', lat: -4.3034, lng: 15.3119 },
   { city: 'Lubumbashi', fr: 'Aéroport international de la Luano', en: 'Luano International Airport', kind: 'AIRPORT', lat: -11.5913, lng: 27.5309 },
   { city: 'Lubumbashi', fr: 'Grand Karavia Hôtel', en: 'Grand Karavia Hotel', kind: 'HOTEL', lat: -11.6422, lng: 27.4766 },
   { city: 'Lubumbashi', fr: 'Hôtel Lubumbashi', en: 'Lubumbashi Hotel', kind: 'HOTEL', lat: -11.6647, lng: 27.4794 },
   { city: 'Lubumbashi', fr: 'Gare de Lubumbashi', en: 'Lubumbashi Railway Station', kind: 'STATION', lat: -11.6625, lng: 27.4803 },
   { city: 'Goma', fr: 'Aéroport international de Goma', en: 'Goma International Airport', kind: 'AIRPORT', lat: -1.6708, lng: 29.2385 },
   { city: 'Goma', fr: 'Ihusi Hôtel', en: 'Ihusi Hotel', kind: 'HOTEL', lat: -1.6939, lng: 29.2308 },
   { city: 'Goma', fr: 'Hôtel Linda', en: 'Linda Hotel', kind: 'HOTEL', lat: -1.6851, lng: 29.2237 },
   { city: 'Goma', fr: 'Port de Goma', en: 'Goma Port', kind: 'PORT', lat: -1.7006, lng: 29.2277 },
]

/** Two cars and two drivers per city; the first car is a Berline, the second an SUV. */
const FLEET: Record<string, { cars: [string, string, string, string][]; drivers: [string, string][] }> = {
   Kinshasa: {
      cars: [['Toyota', 'Corolla', 'Blanche', 'KN 1234 AB'], ['Toyota', 'Prado', 'Noire', 'KN 5678 CD']],
      drivers: [['Papy Mbuyi', '+243810000101'], ['Gloire Kasongo', '+243810000102']],
   },
   Lubumbashi: {
      cars: [['Hyundai', 'Elantra', 'Grise', 'LB 2345 EF'], ['Toyota', 'Fortuner', 'Blanche', 'LB 6789 GH']],
      drivers: [['Jean-Marie Ilunga', '+243810000103'], ['Didier Mwamba', '+243810000104']],
   },
   Goma: {
      cars: [['Toyota', 'Premio', 'Bleue', 'GM 3456 IJ'], ['Toyota', 'Land Cruiser', 'Beige', 'GM 7890 KL']],
      drivers: [['Patrick Bahati', '+243810000105'], ['Espoir Kambale', '+243810000106']],
   },
}

const slugify = (s: string) =>
   s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

/** Replaces the fleet and the rides. Expects an open connection. */
export const seedTransfers = async () => {
   await Promise.all([
      Ride.deleteMany({}),
      Driver.deleteMany({}),
      Vehicle.deleteMany({}),
      VehicleCategory.deleteMany({}),
      TransferPlace.deleteMany({}),
   ])

   // The cities serve transfers, and have a centre for the place search —
   // widened onto an existing row, never narrowed; a pin the office set stays.
   for (const [name, { lat, lng, sortOrder }] of Object.entries(CITIES)) {
      const slug = slugify(name)
      await Location.updateOne(
         { slug },
         {
            $setOnInsert: { name, slug, country: 'CD', kind: 'CITY', isActive: true, sortOrder },
            $addToSet: { servesVerticals: VERTICALS.TRANSFER },
         },
         { upsert: true }
      )
      await Location.updateOne({ slug, 'geo.lat': { $exists: false } }, { $set: { geo: { lat, lng } } })
   }

   const categories = await VehicleCategory.create(CATEGORIES)
   const byName = new Map(categories.map((c) => [c.name.fr, c._id]))

   await TransferPlace.create(
      PLACES.map((p, i) => ({ city: p.city, name: { fr: p.fr, en: p.en }, kind: p.kind, lat: p.lat, lng: p.lng, sortOrder: i }))
   )

   const password = await hashPassword(DEMO_DRIVER_PASSWORD)
   let vehicles = 0
   let drivers = 0
   for (const [city, { cars, drivers: names }] of Object.entries(FLEET)) {
      const made = await Vehicle.create(
         cars.map(([make, model, color, plate], i) => ({
            city,
            category: byName.get(i === 0 ? 'Berline' : 'SUV'),
            make,
            model,
            color,
            plate,
            year: 2019 + i,
         }))
      )
      await Driver.create(
         names.map(([name, phone], i) => ({
            name,
            phone,
            city,
            vehicle: made[i]._id,
            password,
            passwordChangedAt: new Date(),
         }))
      )
      vehicles += made.length
      drivers += names.length
   }

   console.log(
      `Seeded ${categories.length} vehicle categories · ${PLACES.length} places · ${vehicles} vehicles · ${drivers} drivers (password "${DEMO_DRIVER_PASSWORD}")`
   )
}

const run = async () => {
   const uri = buildMongoUri()
   if (!/(localhost|127\.0\.0\.1)/.test(uri) && process.env.SEED_CONFIRM !== '1') {
      throw new Error(
         'Refusing to seed a non-local database. This script replaces the fleet and every ride.\n' +
            'Point MONGODB_URI at a local instance, or set SEED_CONFIRM=1 if you really mean it.'
      )
   }
   if (process.env.NODE_ENV === 'production') {
      throw new Error('seed:transfers refuses to run with NODE_ENV=production')
   }
   await mongoose.connect(uri)
   console.log('connected:', mongoose.connection.name)
   await seedTransfers()
   await mongoose.disconnect()
}

if (require.main === module) {
   run().catch((e) => {
      console.error(e.message)
      process.exit(1)
   })
}
