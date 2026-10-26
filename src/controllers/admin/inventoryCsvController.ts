import { NextFunction, Request, Response } from 'express'
import { Model } from 'mongoose'
import slugify from 'slugify'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { LISTING_STATUS, VERTICALS } from '../../constants/domain.constants'
import { Hotel } from '../../model/hotelModel'
import { Listing } from '../../model/listingModel'
import { Location } from '../../model/locationModel'
import { Restaurant } from '../../model/restaurantModel'
import { Supplier } from '../../model/supplierModel'
import { cleanTimetable, WeeklyTime } from '../../services/orders/schedule.service'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * Inventory in and out as spreadsheets (§5.1, §2.2, §18 Q7).
 *
 * One column list per kind of inventory drives all three things an office does
 * with a spreadsheet: the template it downloads, the export it takes out and
 * the file it brings back. Because they are the same list they cannot drift —
 * an export has exactly the columns the import reads, and the template is that
 * list with one believable row in it.
 *
 * Import only ever ADDS, and what it adds is INACTIVE: a sheet is reviewed in
 * the panel, given its photos and published from there. A dry run is the
 * default (§2.2) — nothing is written until the report is clean and the caller
 * asks — and a commit is one transaction, so a bad row can never half-load a
 * catalogue.
 *
 * Files are read as a French or an English spreadsheet would write them:
 * `;` or `,` between cells, a decimal comma where the separator is `;`, and
 * dates either way round. That is not politeness. Excel in a French locale
 * writes `45,50` and `;` whether anyone asked it to or not.
 */

const MAX_IMPORT_ROWS = 1000
/** Characters of CSV an import will read at all. See `parseCsv` for why. */
const MAX_IMPORT_CHARS = 5_000_000
/** The widest template has about thirty columns. */
const MAX_IMPORT_COLUMNS = 200
/** Far above any catalogue here; a bound, so an export is never unbounded (§2.2). */
const MAX_EXPORT_ROWS = 5000

type Kind =
   | 'text'
   | 'int'
   | 'decimal'
   | 'money'
   | 'datetime'
   | 'time'
   | 'phone'
   | 'list'
   | 'enum'
   | 'bool'
   /** Times of day, "06:30 | 14:00": a bus's departures, every day. */
   | 'times'
   /** Days and times, "Mon 08:00 | Wed 15:45": a flight's week. */
   | 'weekly'

/** What the example row needs that only the database knows. */
interface TemplateContext {
   /** A city this kind of inventory can actually be saved against. */
   city: string
   /** Another one, for the other end of a bus or flight route. */
   destination: string
   /** A departure comfortably ahead, so the example row is one that could sell. */
   departs: Date
}

interface Column {
   /** The header in the file. */
   key: string
   /** Its name in the panel's column guide. */
   label: string
   /** What belongs in the cell, in a sentence. */
   help: string
   /** A believable value: the template's example row, and the guide's. */
   example: string | ((ctx: TemplateContext) => string)
   kind: Kind
   /** Where it lives on the record: `name.fr`, `attributes.segments.0.carrier`. */
   path: string
   required?: boolean
   options?: readonly string[]
   /** Numbers: the bounds. Text: `max` is the length it is cut to. */
   min?: number
   max?: number
   upper?: boolean
   /** Exported for reference, never read back. */
   readOnly?: boolean
}

type Fail = (field: string, message: string) => void

interface GroupSpec {
   label: string
   /** "hotel", "bus service" — for messages. */
   singular: string
   /** Download file name stem. */
   file: string
   entityType: string
   model: Model<any>
   /** Selects this group's records. */
   filter: Record<string, any>
   /** What every new record of the group starts from. */
   base: Record<string, any>
   /** The field the public URL is built from. */
   titlePath: string
   /** Listings may only name a city that sells this vertical (§12). */
   vertical?: string
   columns: Column[]
   /** Checks across cells, and fields derived from them. */
   finish?: (doc: any, fail: Fail) => void
   /** What is still to do in the panel before one of these can be published. */
   after: string
}

const col = (
   key: string,
   label: string,
   kind: Kind,
   path: string,
   example: Column['example'],
   help: string,
   extra: Partial<Column> = {}
): Column => ({ key, label, kind, path, example, help, ...extra })

// --- Columns shared between groups -----------------------------------------

const named = (fr: string, en: string): Column[] => [
   col('name_fr', 'Name (French)', 'text', 'name.fr', fr, 'The name customers see, in French.', {
      required: true,
      max: 200,
   }),
   col('name_en', 'Name (English)', 'text', 'name.en', en,
      'The same in English. Leave blank to show the French name.', { max: 200 }),
]

const titled = (fr: string, en: string): Column[] => [
   col('title_fr', 'Title (French)', 'text', 'title.fr', fr,
      'The heading customers see, in French.', { required: true, max: 200 }),
   col('title_en', 'Title (English)', 'text', 'title.en', en,
      'The same in English. Leave blank to show the French title.', { max: 200 }),
]

const described = (fr: string, en: string): Column[] => [
   col('description_fr', 'Description (French)', 'text', 'description.fr', fr,
      'A few sentences for customers, in French.', { required: true, max: 5000 }),
   col('description_en', 'Description (English)', 'text', 'description.en', en,
      'The same in English. Optional.', { max: 5000 }),
]

const city = (help: string) =>
   col('city', 'City', 'text', 'city', (c) => c.city, help, { required: true, max: 120 })

const SERVICED_CITY = city(
   'Must be one of your serviced Locations, switched on for this kind of product.'
)

const PIN: Column[] = [
   col('latitude', 'Latitude', 'decimal', 'geo.lat', '-4.3217',
      'Map pin. Leave latitude and longitude both blank to show the city centre.',
      { min: -90, max: 90 }),
   col('longitude', 'Longitude', 'decimal', 'geo.lng', '15.3125',
      'Map pin, together with latitude.', { min: -180, max: 180 }),
]

// Whole Congolese francs only: dollars and euros are worked out from the
// exchange rates in Settings.
const PRICES: Column[] = [
   col('cost_price_cdf', 'Cost price (FC)', 'money', 'costPrice.CDF', '128300',
      'What you pay the supplier for one, in francs. Never shown to customers.',
      { required: true, min: 0.01 }),
   col('sell_price_cdf', 'Sell price (FC)', 'money', 'sellPrice.CDF', '199500',
      'What the customer pays for one, in francs. Must be above the cost price. USD and EUR prices are worked out from the exchange rates in Settings.',
      { required: true, min: 0.01 }),
]

/** A bus or flight route's three fares: adult (12+), child (2–12), baby (under 2). */
const FARES: Column[] = [
   col('cost_price_cdf', 'Adult cost (FC)', 'money', 'costPrice.CDF', '128300',
      'What the agency charges you for an adult (12 and over), in francs. Never shown to customers.',
      { required: true, min: 0.01 }),
   col('sell_price_cdf', 'Adult fare (FC)', 'money', 'sellPrice.CDF', '199500',
      'What an adult pays, in francs. Must be above the adult cost. USD and EUR are worked out from the exchange rates in Settings.',
      { required: true, min: 0.01 }),
   col('child_cost_cdf', 'Child cost (FC)', 'money', 'childCostPrice.CDF', '99800',
      'What the agency charges you for a child of 2 to 12, in francs.', { required: true, min: 0 }),
   col('child_fare_cdf', 'Child fare (FC)', 'money', 'childSellPrice.CDF', '156800',
      'What a child of 2 to 12 pays, in francs. Must be above the child cost.',
      { required: true, min: 0.01 }),
   col('baby_cost_cdf', 'Baby cost (FC)', 'money', 'infantCostPrice.CDF', '14300',
      'What the agency charges you for a baby under 2, in francs. 0 if nothing.', { required: true, min: 0 }),
   col('baby_fare_cdf', 'Baby fare (FC)', 'money', 'infantSellPrice.CDF', '28500',
      'What a baby under 2 pays, in francs. 0 if babies travel free.', { required: true, min: 0 }),
]

/**
 * A car's prices: for 24 hours — the one every car has, in the columns that
 * held its price per day, so older files still import — and, each optional,
 * for one hour, 6 hours and 12 hours. The customer pays the cheapest mix that
 * covers their hours.
 */
const CAR_PRICES: Column[] = [
   col('cost_price_cdf', '24-hour cost (FC)', 'money', 'costPrice.CDF', '342000',
      'What you pay the supplier for one car for 24 hours, in francs. Never shown to customers.',
      { required: true, min: 0.01 }),
   col('sell_price_cdf', '24-hour price (FC)', 'money', 'sellPrice.CDF', '513000',
      'What the customer pays for one car for 24 hours, in francs. Must be above the 24-hour cost. USD and EUR are worked out from the exchange rates in Settings.',
      { required: true, min: 0.01 }),
   col('hourly_cost_cdf', 'Hourly cost (FC)', 'money', 'hourlyCostPrice.CDF', '14300',
      'What you pay the supplier for one hour, in francs. Leave both hourly cells blank if you do not rent by the hour.',
      { min: 0 }),
   col('hourly_price_cdf', 'Hourly price (FC)', 'money', 'hourlySellPrice.CDF', '42800',
      'What the customer pays for one hour, in francs. Must be above the hourly cost.', { min: 0 }),
   col('six_hour_cost_cdf', '6-hour cost (FC)', 'money', 'sixHourCostPrice.CDF', '114000',
      'What you pay the supplier for 6 hours, in francs. Leave both 6-hour cells blank if you do not rent for 6 hours.',
      { min: 0 }),
   col('six_hour_price_cdf', '6-hour price (FC)', 'money', 'sixHourSellPrice.CDF', '171000',
      'What the customer pays for 6 hours, in francs. Must be above the 6-hour cost.', { min: 0 }),
   col('twelve_hour_cost_cdf', '12-hour cost (FC)', 'money', 'twelveHourCostPrice.CDF', '199500',
      'What you pay the supplier for 12 hours, in francs. Leave both 12-hour cells blank if you do not rent for 12 hours.',
      { min: 0 }),
   col('twelve_hour_price_cdf', '12-hour price (FC)', 'money', 'twelveHourSellPrice.CDF', '285000',
      'What the customer pays for 12 hours, in francs. Must be above the 12-hour cost.', { min: 0 }),
]

/** A route's two ends: where it leaves from (the record's city) and where it goes. */
const ROUTE_ENDS: Column[] = [
   col('city', 'From (departure point)', 'text', 'city', (c) => c.city,
      'Where it leaves from. Must be one of your serviced Locations, switched on for this kind of product.',
      { required: true, max: 120 }),
   col('destination', 'To (destination)', 'text', 'attributes.destination', (c) => c.destination,
      'Where it goes. Also one of your serviced Locations.', { required: true, max: 120 }),
]

const quantity = (what: string, example: string) =>
   col('quantity', 'Quantity', 'int', 'quantityTotal', example,
      `How many ${what} you have to sell.`, { required: true, min: 1 })

const supplier = (example: string) =>
   col('supplier', 'Supplier', 'text', 'supplier', example,
      'Who you buy it from, by its name under Suppliers (add it there first). Customers never see it.',
      { max: 200 })

/** A route's supplier is its travel agency, and its name is shown as the operator. */
const AGENCY = (example: string) =>
   col('supplier', 'Travel agency', 'text', 'supplier', example,
      'The agency that runs it, by its name under Suppliers (add it there first). Customers see this name as the operator.',
      { required: true, max: 200 })

const VALID_FROM = col('valid_from', 'On sale from', 'datetime', 'validFrom',
   (c) => stamp(new Date(c.departs.getTime() - 30 * DAY)),
   'Optional. The date the service starts.')

/** In every export, read by no import. */
const REFERENCE: Column[] = [
   // A video is a file, uploaded on the item's form; a cell can only say
   // whether there is one, and where it is.
   col('video_url', 'Video', 'text', 'videoUrl', '',
      'Exports only. The address of the video uploaded for this item, if it has one. Videos are added in the panel, not through a spreadsheet.',
      { readOnly: true }),
   col('status', 'Status', 'text', 'status', '',
      'Exports only. Ignored on import: everything imported starts inactive.',
      { readOnly: true }),
   col('slug', 'Reference', 'text', 'slug', '',
      'Exports only. A row whose reference already exists is skipped, so importing an export adds nothing twice.',
      { readOnly: true }),
]

const SOLD = col('quantity_sold', 'Sold', 'int', 'quantitySold', '',
   'Exports only. How many have been sold so far.', { readOnly: true })

// --- Checks across cells ---------------------------------------------------

/** Mirrors the publish rule, so an imported row is a photo away from live. */
const sellable = (doc: any, fail: Fail) => {
   const cost = doc.costPrice?.CDF ?? 0
   const sell = doc.sellPrice?.CDF ?? 0
   if (cost && sell && sell <= cost) {
      fail('sell_price_cdf', 'Sell price must be above the cost price')
   }
}

const pinned = (doc: any, fail: Fail) => {
   if (!doc.geo) return
   const { lat, lng } = doc.geo
   if (lat === undefined || lng === undefined) {
      fail(lat === undefined ? 'latitude' : 'longitude',
         'Give both latitude and longitude, or leave both blank')
   }
}

/** A bus or flight route: its fares in order, its two ends apart, and a time to leave. */
const route = (doc: any, fail: Fail) => {
   sellable(doc, fail)
   const childCost = doc.childCostPrice?.CDF ?? 0
   const childFare = doc.childSellPrice?.CDF ?? 0
   if (childFare && childFare <= childCost) fail('child_fare_cdf', 'Must be above the child cost')
   if ((doc.infantSellPrice?.CDF ?? 0) < (doc.infantCostPrice?.CDF ?? 0)) {
      fail('baby_fare_cdf', 'Cannot be below the baby cost')
   }
   const a = doc.attributes ?? {}
   if (a.destination && doc.city && a.destination.toLowerCase() === doc.city.toLowerCase()) {
      fail('destination', 'Must be different from the departure point')
   }
}

/** A car: each shorter rate it offers has a cost and a price above it, as publishing asks. */
const car = (doc: any, fail: Fail) => {
   sellable(doc, fail)
   for (const [column, sellPath, costPath, what] of [
      ['hourly_price_cdf', 'hourlySellPrice', 'hourlyCostPrice', 'hourly'],
      ['six_hour_price_cdf', 'sixHourSellPrice', 'sixHourCostPrice', '6-hour'],
      ['twelve_hour_price_cdf', 'twelveHourSellPrice', 'twelveHourCostPrice', '12-hour'],
   ]) {
      const sell = doc[sellPath]?.CDF ?? 0
      const cost = doc[costPath]?.CDF ?? 0
      if (!sell) continue
      if (!cost) fail(column, `Give the ${what} cost as well`)
      else if (sell <= cost) fail(column, `Must be above the ${what} cost`)
   }
}

const activity = (doc: any, fail: Fail) => {
   sellable(doc, fail)
   const { minParticipants: min, maxParticipants: max } = doc.attributes ?? {}
   if (min !== undefined && max !== undefined && max < min) {
      fail('max_participants', 'Must be at least the minimum')
   }
}

// --- The groups ------------------------------------------------------------

/**
 * The office's car types, as the panel offers them. Only the sheet holds a
 * car to this list: the record has no enum, so a type typed as text before
 * the list existed still saves.
 */
const CAR_TYPES = ['SUV', 'BERLINE', 'BUS', 'PICKUP', 'MINIBUS', 'TRUCK', 'LUXE'] as const

const DAY = 86400000
const NEXT_YEAR = new Date().getUTCFullYear() + 1

const listing = (vertical: string) => ({
   entityType: 'Listing',
   model: Listing as Model<any>,
   filter: { vertical },
   titlePath: 'title.fr',
   vertical,
})

const GROUPS: Record<string, GroupSpec> = {
   HOTEL: {
      label: 'Hotels',
      singular: 'hotel',
      file: 'hotels',
      entityType: 'Hotel',
      model: Hotel as Model<any>,
      filter: {},
      base: {},
      titlePath: 'name.fr',
      columns: [
         ...named('Hôtel du Fleuve', 'River Hotel'),
         city('The town the hotel is in.'),
         col('address', 'Address', 'text', 'address', '12, avenue du Port, Gombe',
            'Street and district.', { max: 300 }),
         col('stars', 'Stars', 'int', 'stars', '4', 'From 1 to 5. Leave blank if unrated.',
            { min: 0, max: 5 }),
         ...described(
            'Hôtel moderne au bord du fleuve, à dix minutes du centre.',
            'A modern hotel on the river, ten minutes from the centre.'
         ),
         col('amenities', 'Amenities', 'list', 'amenities',
            'Wifi gratuit | Piscine | Parking | Groupe électrogène',
            'What the hotel offers, separated by a | bar.'),
         col('check_in_time', 'Check-in from', 'time', 'checkInTime', '14:00',
            'Earliest arrival, as HH:MM.'),
         col('check_out_time', 'Check-out by', 'time', 'checkOutTime', '11:00',
            'Latest departure, as HH:MM.'),
         col('policies', 'Policies', 'text', 'policies',
            "Une pièce d'identité est demandée à l'arrivée.",
            'House rules customers should know before booking.', { max: 5000 }),
         supplier('Hôtel du Fleuve direct'),
         ...PIN,
         ...REFERENCE,
      ],
      finish: pinned,
      after: 'Then, in the panel: add photos and the room types with their nightly prices, and publish.',
   },

   RESTAURANT: {
      label: 'Restaurants',
      singular: 'restaurant',
      file: 'restaurants',
      entityType: 'Restaurant',
      model: Restaurant as Model<any>,
      filter: {},
      base: {},
      titlePath: 'name.fr',
      columns: [
         ...named('Chez Mama Koko', 'Mama Koko'),
         city('The town the restaurant is in.'),
         col('address', 'Address', 'text', 'address', '8, avenue de la Paix, Gombe',
            'Street and district.', { max: 300 }),
         col('cuisines', 'Cuisines', 'list', 'cuisines', 'Congolais | Grillades',
            'The kinds of food, separated by a | bar.'),
         col('opening_hours', 'Opening hours', 'text', 'openingHours',
            'Lun–Sam 11h00–22h00', 'As you would write it on the door.', { max: 300 }),
         col('phone', 'Phone', 'phone', 'phone', '+243 81 000 00 00',
            'With the country code. Keep the spaces — a spreadsheet turns a bare number into a sum.'),
         col('prep_time_minutes', 'Preparation time (min)', 'int', 'prepTimeMinutes', '30',
            'How long the kitchen usually needs, in minutes.', { min: 0, max: 600 }),
         ...described(
            'Cuisine congolaise maison, grillades au feu de bois.',
            'Home-style Congolese cooking and wood-fired grills.'
         ),
         ...PIN,
         ...REFERENCE,
      ],
      finish: pinned,
      after: 'Then, in the panel: add photos, the menu and at least one delivery zone, and publish.',
   },

   FLIGHT: {
      ...listing(VERTICALS.FLIGHT),
      label: 'Flights',
      singular: 'flight route',
      file: 'flights',
      base: { vertical: VERTICALS.FLIGHT },
      columns: [
         ...titled('Kinshasa → Lubumbashi', 'Kinshasa → Lubumbashi'),
         ...ROUTE_ENDS,
         ...described(
            'Vol direct, un bagage en soute inclus.',
            'Direct flight, one checked bag included.'
         ),
         AGENCY('Congo Airways'),
         col('timetable', 'Weekly timetable', 'weekly', 'attributes.weeklyTimes',
            'Mon 08:00 | Wed 08:00 | Fri 15:45',
            'Each flight of the week as a day and a time, separated by a | bar. Days: Mon Tue Wed Thu Fri Sat Sun (or Lun Mar Mer Jeu Ven Sam Dim).',
            { required: true }),
         col('duration_minutes', 'Flight time (minutes)', 'int', 'attributes.durationMinutes', '150',
            'How long the flight takes, to show the arrival time. Optional.', { min: 1, max: 2880 }),
         col('cabin', 'Cabin', 'enum', 'attributes.cabin', 'ECONOMY', 'The class of travel.',
            { options: ['ECONOMY', 'PREMIUM', 'BUSINESS', 'FIRST'] }),
         col('baggage', 'Baggage allowance', 'text', 'attributes.baggage',
            '1 bagage en soute 23 kg + 1 bagage cabine', 'What is included.', { max: 300 }),
         col('fare_rules', 'Fare rules', 'text', 'attributes.fareRules',
            'Non modifiable. Non remboursable.', 'Change and refund conditions.', { max: 1000 }),
         ...FARES,
         ...REFERENCE,
      ],
      finish: route,
      after: 'Then, in the panel: add a photo and publish.',
   },

   BUS: {
      ...listing(VERTICALS.BUS),
      label: 'Bus',
      singular: 'bus route',
      file: 'bus',
      base: { vertical: VERTICALS.BUS },
      columns: [
         ...titled('Kinshasa → Matadi', 'Kinshasa → Matadi'),
         ...ROUTE_ENDS,
         ...described('Départ quotidien, car climatisé.', 'Daily departure, air-conditioned coach.'),
         AGENCY('Transco'),
         col('departure_times', 'Departure times', 'times', 'attributes.dailyTimes',
            '06:30 | 10:00 | 14:00',
            'The times it leaves, every day, separated by a | bar. The customer picks the date and one of these.',
            { required: true }),
         col('duration_minutes', 'Journey time (minutes)', 'int', 'attributes.durationMinutes', '360',
            'How long the journey takes, to show the arrival time. Optional.', { min: 1, max: 4320 }),
         col('vehicle_class', 'Vehicle class', 'text', 'attributes.vehicleClass', 'Climatisé',
            'For example Climatisé, VIP, Standard.', { max: 120 }),
         col('route_stops', 'Stops on the way', 'list', 'attributes.routeStops',
            'Kisantu | Mbanza-Ngungu', 'Towns the bus stops in, separated by a | bar.'),
         ...FARES,
         ...REFERENCE,
      ],
      finish: route,
      after: 'Then, in the panel: add a photo and publish.',
   },

   CAR: {
      ...listing(VERTICALS.CAR),
      label: 'Cars',
      singular: 'car',
      file: 'cars',
      base: { vertical: VERTICALS.CAR },
      columns: [
         ...titled('Toyota Prado — avec chauffeur', 'Toyota Prado — with driver'),
         SERVICED_CITY,
         ...described('4x4 récent, climatisé, idéal hors de la ville.',
            'A recent air-conditioned 4x4, good for leaving town.'),
         col('make', 'Make', 'text', 'attributes.make', 'Toyota', 'The manufacturer.',
            { required: true, max: 80 }),
         col('model', 'Model', 'text', 'attributes.model', 'Prado', 'The model.', { max: 80 }),
         col('year', 'Year', 'int', 'attributes.year', '2022', 'Year of manufacture.',
            { min: 1980, max: NEXT_YEAR }),
         col('category', 'Car type', 'enum', 'attributes.category', 'SUV',
            'SUV, BERLINE (saloon), BUS, PICKUP, MINIBUS, TRUCK or LUXE (luxury).',
            { options: CAR_TYPES }),
         col('transmission', 'Gearbox', 'enum', 'attributes.transmission', 'AUTOMATIC',
            'How it is driven.', { options: ['MANUAL', 'AUTOMATIC'] }),
         col('with_driver', 'With driver', 'bool', 'attributes.withDriver', 'yes',
            'yes if a driver comes with the car, no if the customer drives.'),
         col('deposit_cdf', 'Deposit (FC)', 'money', 'attributes.deposit', '855000',
            'Held against damage, in francs. Leave blank for none.', { min: 0 }),
         col('mileage_limit', 'Mileage limit', 'text', 'attributes.mileageLimit',
            '200 km / jour', 'As you would tell the customer.', { max: 120 }),
         col('pickup_locations', 'Pick-up points', 'list', 'attributes.pickupLocations',
            'Aéroport de Ndjili | Centre-ville', 'Where the car can be collected, separated by a | bar.'),
         col('insurance_terms', 'Insurance', 'text', 'attributes.insuranceTerms',
            'Assurance au tiers, franchise 500 $', 'What cover is included.', { max: 500 }),
         ...CAR_PRICES,
         quantity('cars', '3'),
         VALID_FROM,
         supplier('Kinshasa Fleet'),
         SOLD,
         ...REFERENCE,
      ],
      finish: car,
      after: 'Then, in the panel: add a photo and publish.',
   },

   ACTIVITY: {
      ...listing(VERTICALS.ACTIVITY),
      label: 'Activities & Tours',
      singular: 'activity',
      file: 'activities',
      base: { vertical: VERTICALS.ACTIVITY },
      columns: [
         ...titled('Croisière sur le fleuve Congo', 'Congo River cruise'),
         SERVICED_CITY,
         ...described('Deux heures sur le fleuve au coucher du soleil.',
            'Two hours on the river at sunset.'),
         col('duration_minutes', 'Duration (minutes)', 'int', 'attributes.durationMinutes',
            '120', 'How long it lasts, in minutes. A full day is 480.',
            { required: true, min: 1 }),
         col('meeting_point', 'Meeting point', 'text', 'attributes.meetingPoint',
            'Port de Kinshasa, quai 3', 'Where customers should turn up.', { max: 300 }),
         col('languages', 'Languages', 'list', 'attributes.languages', 'Français | Anglais',
            'Languages the guide speaks, separated by a | bar.'),
         col('min_participants', 'Minimum people', 'int', 'attributes.minParticipants', '2',
            'The fewest it runs for.', { min: 1 }),
         col('max_participants', 'Maximum people', 'int', 'attributes.maxParticipants', '12',
            'The most it can take.', { min: 1 }),
         col('inclusions', 'Included', 'list', 'attributes.inclusions',
            'Guide | Boissons | Gilets de sauvetage', 'What the price covers, separated by a | bar.'),
         col('exclusions', 'Not included', 'list', 'attributes.exclusions',
            'Pourboires | Transport', 'What it does not cover, separated by a | bar.'),
         col('advance_notice_hours', 'Book ahead (hours)', 'int',
            'attributes.advanceNoticeHours', '24', 'How much notice you need.', { min: 0 }),
         col('child_price_cdf', 'Child price (FC)', 'money', 'attributes.childPrice', '99800',
            'In francs. Leave blank if children pay the full price.', { min: 0 }),
         ...PRICES,
         quantity('places', '12'),
         VALID_FROM,
         supplier('Kinshasa Tours'),
         SOLD,
         ...REFERENCE,
      ],
      finish: activity,
      after: 'Then, in the panel: add a photo and publish.',
   },

   PROPERTY: {
      ...listing(VERTICALS.PROPERTY),
      label: 'Properties',
      singular: 'property',
      file: 'properties',
      // No stock and no cost of goods: a property is an enquiry, never a
      // checkout (§5.2), so there is exactly one and it cost nothing to hold.
      base: { vertical: VERTICALS.PROPERTY, quantityTotal: 1, costPrice: { CDF: 0 } },
      columns: [
         ...titled('Villa 4 chambres — Gombe', '4-bedroom villa — Gombe'),
         SERVICED_CITY,
         ...described('Belle villa avec jardin, proche des ambassades.',
            'A fine villa with a garden, near the embassies.'),
         col('property_type', 'Type', 'enum', 'attributes.propertyType', 'HOUSE_SALE',
            'What it is and whether it is for sale or to rent.', {
               required: true,
               options: ['HOUSE_SALE', 'LAND_SALE', 'APARTMENT_RENT', 'HOUSE_RENT', 'LAND_RENT'],
            }),
         col('price_basis', 'Price is', 'enum', 'attributes.priceBasis', 'TOTAL',
            'TOTAL for a sale price, PER_MONTH for rent.', { options: ['TOTAL', 'PER_MONTH'] }),
         col('price_cdf', 'Price (FC)', 'money', 'sellPrice.CDF', '712500000',
            'The asking price or the monthly rent, in francs. USD and EUR are worked out from the exchange rates in Settings.',
            { required: true, min: 0.01 }),
         col('bedrooms', 'Bedrooms', 'int', 'attributes.bedrooms', '4', 'Number of bedrooms.',
            { min: 0 }),
         col('bathrooms', 'Bathrooms', 'int', 'attributes.bathrooms', '3',
            'Number of bathrooms.', { min: 0 }),
         col('area_sqm', 'Area (m²)', 'decimal', 'attributes.areaSqm', '320',
            'In square metres: a house, its built area; an apartment, its floor area; land, the size of the plot.',
            { min: 0 }),
         col('plot_size_sqm', 'Plot size (m²)', 'decimal', 'attributes.plotSizeSqm', '900',
            'Houses only: the land the house stands on, in square metres. Leave blank for an apartment or land — land gives its size in area_sqm.',
            { min: 0 }),
         col('features', 'Features', 'list', 'attributes.features',
            'Parking | Groupe électrogène | Forage | Gardiennage 24 h',
            'What it comes with, separated by a | bar.'),
         col('title_deed_status', 'Title deed', 'text', 'attributes.titleDeedStatus',
            "Certificat d'enregistrement au nom du vendeur",
            'The legal status of the title.', { max: 300 }),
         col('availability_status', 'Availability', 'enum', 'attributes.availabilityStatus',
            'AVAILABLE', 'Where the sale or let stands.',
            { options: ['AVAILABLE', 'UNDER_OFFER', 'SOLD', 'RENTED'] }),
         ...PIN,
         ...REFERENCE,
      ],
      finish: pinned,
      after: 'Then, in the panel: add at least 3 photos and publish.',
   },
}

// --- Reading and writing cells ---------------------------------------------

const getPath = (obj: any, path: string) =>
   path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

const setPath = (obj: any, path: string, value: unknown) => {
   const keys = path.split('.')
   let at = obj
   keys.slice(0, -1).forEach((k, i) => {
      // `segments.0.carrier` needs a list where the next step is a number.
      if (at[k] == null) at[k] = /^\d+$/.test(keys[i + 1]) ? [] : {}
      at = at[k]
   })
   at[keys[keys.length - 1]] = value
}

/**
 * NUL would make the driver throw; one apostrophe before = + - @ where a cell
 * could be taken to start is the formula guard an export put there, not part
 * of the value. Exactly one comes off, as exactly one went on (see `inert`),
 * so an export read back in is the text that was exported.
 *
 * ponytail: a file typed by hand cannot say which it means, so its own `;'-`
 * comes in as `;-`. Vanishingly rare in names and descriptions; if it ever
 * matters, have exports mark their guard with a character no keyboard types.
 */
const clean = (v: unknown) =>
   String(v ?? '')
      .replace(/\0/g, '')
      .trim()
      // `inert` backwards: the guard at the start, then the ones inside.
      .replace(/^'(?='*[=+\-@\t\r])/, '')
      .replace(/([,;\t])'(?='*[=+\-@\t\r])|([\n\r])'(?='*[=+@])/g, '$1$2')

/**
 * A number as a spreadsheet wrote it, as the plain `1250.50` it means — or
 * null when it is not a number at all.
 *
 * `1 234,50` and `1,234.50` are the same amount written by two spreadsheets.
 * Which one a comma means depends on the file. Where cells are split by `;`
 * it is the decimal mark, as French Excel writes it. Anywhere else it groups
 * thousands — unless it is plainly a decimal, which is what someone typing by
 * hand into any file means by it: one or two digits after it (`45,5`,
 * `45,50`), or four and more (`-4,3217`, a map pin as French Google Sheets
 * writes it into a comma file). Groups of thousands are always three.
 */
const plainNumber = (raw: string, decimalComma: boolean): string | null => {
   // \s covers the no-break spaces French formatting groups digits with.
   let t = raw.replace(/\s/g, '')
   if (decimalComma || /^-?\d+,(\d{1,2}|\d{4,})$/.test(t)) {
      if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
   } else {
      t = t.replace(/,/g, '')
   }
   return /^-?\d+(\.\d+)?$/.test(t) ? t : null
}

/** Digits after the decimal point, as written. */
const decimalsOf = (plain: string) => (plain.split('.')[1] ?? '').length

/** Which way round a file writes 03/05/2027. */
type SlashOrder = 'DMY' | 'MDY'
const SLASH_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{4}(?:\s|$)/

/**
 * `2026-12-24T08:00`, `2026-12-24 08:00` or `24/12/2026 08:00`, the time
 * optional. Read as UTC, like every other date in the system, so a file means
 * the same thing whichever server opens it.
 *
 * A slash date is day-first unless the file as a whole says otherwise — see
 * `slashOrderOf`.
 */
const toDate = (raw: string, order: SlashOrder = 'DMY'): Date | null => {
   const t = raw.trim().replace('T', ' ')
   const time = '(?:\\s+(\\d{1,2}):(\\d{2})(?::\\d{2}(?:\\.\\d+)?)?)?Z?'
   let m = t.match(new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${time}$`))
   let y: string, mo: string, d: string
   if (m) [, y, mo, d] = m
   else {
      m = t.match(new RegExp(`^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})${time}$`))
      if (!m) return null
      ;[, d, mo, y] = m
      if (order === 'MDY') [d, mo] = [mo, d]
   }
   const [h, mi] = [Number(m[4] ?? 0), Number(m[5] ?? 0)]
   if (h > 23 || mi > 59) return null
   const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), h, mi))
   // Date.UTC rolls 31/02 over into March. Refuse rather than guess.
   if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null
   return date
}

/**
 * `2026-12-24T08:00`. The T is deliberate: a spreadsheet leaves this form
 * alone, where it would rewrite `2026-12-24 08:00` in the local order of day
 * and month on the way back out.
 */
const stamp = (d: Date) => d.toISOString().slice(0, 16)

/** Day names a timetable may use, French or English, whole or short: index = day of week. */
const DAY_NAMES = [
   ['sun', 'sunday', 'dim', 'dimanche'],
   ['mon', 'monday', 'lun', 'lundi'],
   ['tue', 'tuesday', 'mar', 'mardi'],
   ['wed', 'wednesday', 'mer', 'mercredi'],
   ['thu', 'thursday', 'jeu', 'jeudi'],
   ['fri', 'friday', 'ven', 'vendredi'],
   ['sat', 'saturday', 'sam', 'samedi'],
]
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "8:05" or "08:05" as "08:05", or null. */
const clock = (raw: string) => {
   const m = raw.trim().match(/^(\d{1,2})[:hH](\d{2})$/)
   return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? `${m[1].padStart(2, '0')}:${m[2]}` : null
}

const YES = ['yes', 'y', 'oui', 'o', 'true', 'vrai', '1']
const NO = ['no', 'n', 'non', 'false', 'faux', '0']

const between = (n: number, c: Column): string | null => {
   if (c.min !== undefined && n < c.min) {
      return c.min > 0 && c.min < 1 ? 'Must be more than zero' : `Must be ${c.min} or more`
   }
   if (c.max !== undefined && n > c.max) return `Must be ${c.max} or less`
   return null
}

interface Reading {
   decimalComma: boolean
   slashOrder: SlashOrder
}

export const readCell = (
   c: Column,
   raw: string,
   { decimalComma, slashOrder }: Reading
): { value?: unknown; error?: string } => {
   switch (c.kind) {
      case 'text': {
         const text = raw.slice(0, c.max ?? 500)
         return { value: c.upper ? text.toUpperCase() : text }
      }
      case 'int': {
         const plain = plainNumber(raw, decimalComma)
         // `1.000` is a thousand to half the world and one to the other half,
         // and a count has no business carrying three decimals either way.
         if (plain !== null && decimalsOf(plain) === 3) {
            return { error: 'Write the number without a thousands separator, like 1000' }
         }
         const n = plain === null ? null : Number(plain)
         if (n === null || !Number.isInteger(n)) return { error: 'Must be a whole number' }
         const out = between(n, c)
         return out ? { error: out } : { value: n }
      }
      case 'decimal': {
         const plain = plainNumber(raw, decimalComma)
         if (plain === null) return { error: 'Must be a number' }
         const out = between(Number(plain), c)
         return out ? { error: out } : { value: Number(plain) }
      }
      case 'money': {
         const plain = plainNumber(raw, decimalComma)
         if (plain === null || Number(plain) < 0) {
            return { error: 'Must be an amount in francs, like 513000' }
         }
         // Three decimals mean a thousands mark was taken for the decimal
         // point — 513.000 read as 513 — and a price a thousand times too small
         // is not one to import on a guess.
         if (decimalsOf(plain) === 3) {
            return { error: 'Write the amount without a thousands separator, like 513000' }
         }
         // Francs have no cents, and this file never writes any: 45.50 — or
         // 180.00, how the dollar-era export wrote $180 — is a dollar price
         // left in a franc column, not 46 or 180 francs.
         if (decimalsOf(plain) > 0) {
            return { error: 'Write whole francs, with no decimals, like 513000' }
         }
         const out = between(Number(plain), c)
         // Whole francs on the record, exactly as the panel's price boxes store them.
         return out ? { error: out } : { value: Number(plain) }
      }
      case 'datetime': {
         const d = toDate(raw, slashOrder)
         return d ? { value: d } : { error: 'Must be a date, like 2026-12-24T08:00' }
      }
      case 'time': {
         const m = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
         if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
            return { error: 'Must be a time, like 14:00' }
         }
         return { value: `${m[1].padStart(2, '0')}:${m[2]}` }
      }
      case 'phone': {
         const compact = raw.replace(/[\s.\-()]/g, '')
         // 2.4381E+11 is what a spreadsheet makes of a number typed bare.
         if (!/^\+?\d{6,15}$/.test(compact)) {
            return { error: 'Must be a phone number, like +243 81 000 00 00' }
         }
         return { value: compact }
      }
      case 'list':
         return {
            value: raw
               .split('|')
               .map((s) => s.trim().slice(0, 200))
               .filter(Boolean)
               .slice(0, 40),
         }
      case 'enum': {
         const want = raw.toUpperCase().replace(/[\s-]+/g, '_')
         return c.options!.includes(want)
            ? { value: want }
            : { error: `Must be one of: ${c.options!.join(', ')}` }
      }
      case 'bool': {
         const want = raw.toLowerCase()
         if (YES.includes(want)) return { value: true }
         if (NO.includes(want)) return { value: false }
         return { error: 'Must be yes or no' }
      }
      case 'times': {
         const parts = raw.split('|').map((t) => t.trim()).filter(Boolean)
         const times = parts.map(clock)
         if (!parts.length || times.some((t) => !t)) {
            return { error: 'Must be times separated by a | bar, like 06:30 | 14:00' }
         }
         return { value: cleanTimetable({ dailyTimes: times }).dailyTimes }
      }
      case 'weekly': {
         const parts = raw.split('|').map((t) => t.trim()).filter(Boolean)
         const week: WeeklyTime[] = []
         for (const part of parts) {
            const [name, time] = part.split(/\s+/)
            const day = DAY_NAMES.findIndex((names) => names.includes(String(name).toLowerCase().replace('.', '')))
            const at = clock(time ?? '')
            if (day < 0 || !at) {
               return { error: `"${part}" is not a day and a time, like Mon 08:00 or Lun 08:00` }
            }
            week.push({ day, time: at })
         }
         if (!week.length) return { error: 'Give at least one day and time, like Mon 08:00' }
         return { value: cleanTimetable({ weeklyTimes: week }).weeklyTimes }
      }
   }
}

/**
 * A cell that starts with = + - or @ is run as a formula by a spreadsheet.
 * Text never should be, whoever typed it — prefixed, it is shown as written.
 *
 * "Starts" as the program opening the file sees it. One set to split on `;`
 * reads `Toyota;=SUM(…)` out of a comma file as two cells, the second of them
 * a formula, so the guard also goes after anything that could pass for a
 * separator there. After a line break it leaves the dash alone: `- ` bullets
 * are how policies and inclusions are written, and an apostrophe on each line
 * of every one would be a worse file.
 *
 * The guard goes in front of any apostrophes already there, so a value that
 * really begins `'=` leaves as `''=` and `clean` hands back the original.
 */
const inert = (s: string) =>
   s
      // What an import would trim anyway. Guarded with it still on, `Transco,`
      // followed by a tab came back as `Transco,'`: the guard went in before
      // the tab, and the import then took only the tab away.
      .trim()
      .replace(/([,;\t])(?='*[=+\-@\t\r])|([\n\r])(?='*[=+@])/g, "$1$2'")
      // The start on its own, after the rest: taken in the same pass, a value
      // beginning with a tab was guarded as a start and the tab then skipped
      // as a separator, so `<tab>=1+1` still ran once split on tabs.
      .replace(/^(?='*[=+\-@\t\r])/, "'")

type Delimiter = ',' | ';'

/** A number the way the reader's spreadsheet expects to be handed one. */
const localNumber = (n: string, delimiter: Delimiter) =>
   delimiter === ';' ? n.replace('.', ',') : n

const writeCell = (c: Column, doc: any, delimiter: Delimiter): string => {
   const v = getPath(doc, c.path)
   if (v === undefined || v === null || v === '') return ''
   switch (c.kind) {
      case 'money':
         return String(Math.round(Number(v)))
      case 'decimal':
         return localNumber(String(v), delimiter)
      case 'int':
         return String(v)
      case 'datetime':
         return stamp(new Date(v))
      case 'list':
      case 'times':
         return inert((v as string[]).join(' | '))
      case 'weekly':
         return (v as WeeklyTime[]).map((w) => `${DAY_SHORT[w.day]} ${w.time}`).join(' | ')
      case 'bool':
         return v ? 'yes' : 'no'
      default:
         // Text — and phone, time and a fixed choice, which can be free
         // strings on the record however strictly an import reads them (a car
         // type typed before the list has no enum to stop it). Guarded, a phone
         // number also survives a spreadsheet instead of turning into 2.4381E+11.
         return inert(String(v))
   }
}

const exampleOf = (c: Column, ctx: TemplateContext, delimiter: Delimiter = ',') => {
   // What the database supplies (a city's name) is as untrusted as any cell.
   const text = typeof c.example === 'function' ? inert(c.example(ctx)) : c.example
   return c.kind === 'money' || c.kind === 'decimal' ? localNumber(text, delimiter) : text
}

// --- The file itself -------------------------------------------------------

/**
 * The byte-order mark. An escape on purpose: as a literal character it is
 * invisible here, and one tidy-up by an editor would silently remove it.
 */
const BOM = '\uFEFF'

/** Quoted only when it has to be: a quote, a line break, or this file's separator. */
const csvCell = (v: string, delimiter: Delimiter) =>
   v.includes('"') || v.includes(delimiter) || /[\n\r]/.test(v)
      ? `"${v.replace(/"/g, '""')}"`
      : v

/**
 * UTF-8 with a byte-order mark: without it Excel reads the file as Latin-1 and
 * every é and → arrives as two wrong characters.
 */
const sendCsv = (res: Response, name: string, rows: string[][], delimiter: Delimiter) => {
   res.set('Content-Type', 'text/csv; charset=utf-8')
   res.set('Content-Disposition', `attachment; filename="${name}"`)
   // The panel is another origin; it needs to be allowed to read the name.
   res.set('Access-Control-Expose-Headers', 'Content-Disposition')
   res.send(
      BOM +
         rows.map((r) => r.map((v) => csvCell(v, delimiter)).join(delimiter)).join('\r\n') +
         '\r\n'
   )
}

const SEPARATORS = [',', ';', '\t'] as const

/** Whichever of , ; or tab the header row uses most, outside quotes. */
const detectSeparator = (text: string): string => {
   const seen: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
   let inQuotes = false
   for (const c of text) {
      if (c === '"') inQuotes = !inQuotes
      else if (!inQuotes) {
         if (c === '\n') break
         if (c in seen) seen[c] += 1
      }
   }
   // Stable sort, so a single-column file falls back to the comma.
   return [...SEPARATORS].sort((a, b) => seen[b] - seen[a])[0]
}

const normaliseHeader = (h: string) =>
   h
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')

/**
 * RFC 4180, with the separator worked out rather than assumed.
 *
 * Bounded while it reads, not afterwards. Building every row of a large file
 * and counting them at the end costs around thirty bytes of heap a character:
 * a few megabytes of short lines is a gigabyte, and the process that would run
 * out is the one serving the public site. So blank lines are counted but never
 * kept, and the row limit stops the read the moment it is passed.
 */
const parseCsv = (input: string) => {
   // One kind of line ending from here on. Excel's "CSV (Macintosh)" ends rows
   // with a bare CR, which would otherwise run every row into the header.
   let text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
   // Excel's own hint line, when someone saved the file with one.
   const hint = text.match(/^sep=(.)\n/i)
   if (hint) text = text.slice(hint[0].length)
   const separator = hint ? hint[1] : detectSeparator(text)

   let header: string[] | null = null
   const records: { rowNo: number; cells: Record<string, string> }[] = []
   let field = ''
   let row: string[] = []
   let inQuotes = false
   // Numbered as the spreadsheet numbers them, blank rows included.
   let rowNo = 0

   const endRow = () => {
      row.push(field)
      field = ''
      const cells = row
      row = []
      rowNo += 1
      if (!cells.some((c) => c.trim())) return
      if (!header) {
         // Every row is keyed by every header, so the width is bounded as well:
         // a hundred thousand names over a thousand one-cell rows is half a
         // megabyte of file and several gigabytes of objects.
         // Trailing blanks are a spreadsheet's doing (a stray space far to the
         // right), not columns, and are dropped before they are counted.
         let width = cells.length
         while (width && !cells[width - 1].trim()) width -= 1
         if (width > MAX_IMPORT_COLUMNS) {
            throw new AppError(
               'That file has far more columns than any template. Start again from the template.',
               400
            )
         }
         header = cells.slice(0, width).map(normaliseHeader)
         return
      }
      if (records.length >= MAX_IMPORT_ROWS) {
         throw new AppError(`An import is limited to ${MAX_IMPORT_ROWS} rows per file`, 400)
      }
      const names = header
      records.push({
         rowNo,
         cells: Object.fromEntries(names.map((h, i) => [h, cells[i] ?? ''])),
      })
   }

   for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inQuotes) {
         if (c === '"' && text[i + 1] === '"') {
            field += '"'
            i++
         } else if (c === '"') inQuotes = false
         else field += c
      }
      // A quote opens a quoted cell only at the start of one. Anywhere else it
      // is a character — a 55" screen — which is how a spreadsheet reads it,
      // and what stops one stray mark swallowing every row after it.
      else if (c === '"' && field === '') inQuotes = true
      else if (c === separator) {
         row.push(field)
         field = ''
      } else if (c === '\n') endRow()
      else field += c
   }
   if (inQuotes) {
      throw new AppError(
         'A quoted cell in that file is never closed. Look for a stray " at the start of a cell.',
         400
      )
   }
   if (field || row.length) endRow()

   return {
      header: ((header ?? []) as string[]).filter(Boolean),
      records,
      decimalComma: separator === ';',
   }
}

/**
 * 03/05/2027 is the 3rd of May in Kinshasa and the 5th of March in New York,
 * and a spreadsheet writes whichever its own settings say. No single cell can
 * settle that, but a whole file usually can: one date whose "month" is above
 * twelve gives the order away for every other date in it.
 */
const slashOrderOf = (
   records: { cells: Record<string, string> }[],
   columns: Column[]
): { order: SlashOrder; conflict: boolean; sample?: string; settled: boolean } => {
   const dated = columns.filter((c) => c.kind === 'datetime')
   let dayFirst = false
   let monthFirst = false
   let sample: string | undefined
   for (const { cells } of records) {
      for (const c of dated) {
         const cell = clean(cells[c.key])
         const m = cell.match(SLASH_DATE)
         if (!m) continue
         sample ??= cell
         if (Number(m[1]) > 12) dayFirst = true
         if (Number(m[2]) > 12) monthFirst = true
      }
   }
   return {
      order: monthFirst && !dayFirst ? 'MDY' : 'DMY',
      conflict: dayFirst && monthFirst,
      sample,
      settled: dayFirst || monthFirst,
   }
}

// --- Request plumbing ------------------------------------------------------

const groupOf = (req: Request) => {
   const group = String(req.params.group ?? '').toUpperCase()
   const spec = GROUPS[group]
   if (!spec) throw new AppError('Unknown kind of inventory', 404)
   return { group, spec }
}

/** `;` for a French spreadsheet, `,` for an English one. */
const delimiterOf = (req: Request): Delimiter =>
   req.query.sep === 'semicolon' || req.query.sep === ';' ? ';' : ','

const templateContext = async (spec: GroupSpec): Promise<TemplateContext> => {
   // A real city, so the untouched template passes its own validation.
   const [place, other] = await Location.find({
      isActive: true,
      ...(spec.vertical ? { servesVerticals: spec.vertical } : {}),
   })
      .sort({ sortOrder: 1, name: 1 })
      .limit(2)
      .select('name')
      .lean()
   const soon = new Date(Date.now() + 30 * DAY)
   return {
      city: (place as any)?.name ?? 'Kinshasa',
      destination: (other as any)?.name ?? 'Matadi',
      departs: new Date(
         Date.UTC(soon.getUTCFullYear(), soon.getUTCMonth(), soon.getUTCDate(), 8, 0)
      ),
   }
}

// --- Handlers --------------------------------------------------------------

/** GET /inventory/:group/import-columns — the guide the import panel shows. */
export const importColumns = catchAsync(async (req: Request, res: Response) => {
   const { group, spec } = groupOf(req)
   const ctx = await templateContext(spec)
   return sendResponse(res, 200, 'OK', {
      group,
      label: spec.label,
      maxRows: MAX_IMPORT_ROWS,
      after: spec.after,
      columns: spec.columns.map((c) => ({
         key: c.key,
         label: c.label,
         required: Boolean(c.required),
         readOnly: Boolean(c.readOnly),
         help: c.help,
         example: exampleOf(c, ctx),
         options: c.options,
      })),
   })
})

/** GET /inventory/:group/template — the columns, and one row to copy. */
export const template = catchAsync(async (req: Request, res: Response) => {
   const { spec } = groupOf(req)
   const delimiter = delimiterOf(req)
   const ctx = await templateContext(spec)
   const columns = spec.columns.filter((c) => !c.readOnly)
   sendCsv(
      res,
      `${spec.file}-template.csv`,
      [columns.map((c) => c.key), columns.map((c) => exampleOf(c, ctx, delimiter))],
      delimiter
   )
})

/**
 * GET /inventory/:group/export — everything in the group that is not archived.
 *
 * Cost prices and supplier names leave the building in this file, so it is
 * written to the audit log like any other bulk read (§14.4).
 */
export const exportCsv = catchAsync(async (req: Request, res: Response) => {
   const { group, spec } = groupOf(req)
   const delimiter = delimiterOf(req)
   const docs = await spec.model
      .find({ ...spec.filter, status: { $ne: LISTING_STATUS.ARCHIVED } })
      .sort({ _id: -1 })
      .limit(MAX_EXPORT_ROWS)
      .lean()
   // A supplier leaves by its name, the way an import reads it back.
   const names = new Map(
      (await Supplier.find({}).select('name').lean()).map((x: any) => [String(x._id), x.name])
   )
   for (const doc of docs as any[]) {
      if (doc.supplier) doc.supplier = names.get(String(doc.supplier)) ?? ''
   }

   await recordAudit(req, {
      action: AUDIT_ACTIONS.INVENTORY_EXPORTED,
      entityType: spec.entityType,
      after: { group, rows: docs.length },
      reason: `Exported ${docs.length} ${spec.label.toLowerCase()}`,
   })

   sendCsv(
      res,
      `${spec.file}-${new Date().toISOString().slice(0, 10)}.csv`,
      [
         spec.columns.map((c) => c.key),
         ...docs.map((doc) => spec.columns.map((c) => writeCell(c, doc, delimiter))),
      ],
      delimiter
   )
})

/**
 * POST /inventory/:group/import  { csv, commit? }
 *
 * Without `commit: true` this validates and reports, writing nothing.
 */
export const importCsv = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { group, spec } = groupOf(req)
      const { csv } = req.body ?? {}
      // Exactly true. A caller that sends the string "false" has not asked.
      const commit = req.body?.commit === true
      if (!csv || typeof csv !== 'string') {
         return next(new AppError('Choose a CSV file to import', 400))
      }
      // A thousand generous rows fit several times over. Past this it is the
      // wrong file, and reading it would cost far more memory than its size.
      if (csv.length > MAX_IMPORT_CHARS) {
         return next(
            new AppError(
               `That file is too large to import. An import is limited to ${MAX_IMPORT_ROWS} rows.`,
               413
            )
         )
      }

      const { header, records, decimalComma } = parseCsv(csv)
      // A file from before prices were in francs: its amounts are dollars, and
      // read into these columns they would be francs. Said once, for the file.
      const dollars = header.filter((h) => h.endsWith('_usd'))
      if (dollars.length) {
         const renames = dollars.map((h) => `${h} to ${h.replace(/_usd$/, '_cdf')}`).join(', ')
         return next(
            new AppError(`Prices are now in Congolese francs: rename ${renames} and enter francs`, 400)
         )
      }
      if (!records.length) {
         return next(new AppError('That file has no rows under its header', 400))
      }

      const errors: { row: number; field: string; message: string }[] = []
      const notes: string[] = []
      const importable = spec.columns.filter((c) => !c.readOnly)
      const known = new Set(spec.columns.map((c) => c.key))
      const ignoredColumns = header.filter((h) => !known.has(h))

      // A required column the file does not have at all is one problem with
      // the file, not the same problem on each of its thousand rows.
      const missing = new Set(
         importable.filter((c) => c.required && !header.includes(c.key)).map((c) => c.key)
      )
      missing.forEach((key) =>
         errors.push({ row: 1, field: key, message: 'This column is missing from the file' })
      )

      // Which way round this file writes its dates, said out loud whenever it
      // had to be assumed — a departure on the wrong day is found by a customer.
      const dates = slashOrderOf(records, importable)
      if (dates.conflict) {
         errors.push({
            row: 1,
            field: 'dates',
            message:
               'Some dates in this file are day first and others month first. Write them all one way, or as 2026-12-24T08:00.',
         })
      } else if (dates.order === 'MDY') {
         notes.push(`Dates like ${dates.sample} were read month first, as this file writes them.`)
      } else if (dates.sample && !dates.settled) {
         notes.push(
            `Dates like ${dates.sample} were read day first (day/month/year). If that is not what you meant, write them as 2026-12-24T08:00.`
         )
      }
      const reading: Reading = { decimalComma, slashOrder: dates.order }

      // ponytail: every slug in the collection, read once, to skip what is
      // already here and hand out unique new ones in a single pass. Fine at
      // catalogue size; switch to a prefix query per title past ~100k records.
      const taken = new Set<string>(
         (await spec.model.find({}).select('slug').lean()).map((d: any) => d.slug)
      )
      const places = new Map(
         (await Location.find({}).select('name isActive servesVerticals').lean()).map(
            (l: any) => [String(l.name).trim().toLowerCase(), l]
         )
      )
      const suppliers = new Map(
         (await Supplier.find({}).select('name isActive').lean()).map((x: any) => [
            String(x.name).trim().toLowerCase(),
            x,
         ])
      )

      let skipped = 0
      const failedRows = new Set<number>()
      const prepared: any[] = []

      for (const { rowNo, cells } of records) {
         // An export read back in: the record is already here.
         const reference = clean(cells.slug).toLowerCase()
         if (reference && taken.has(reference)) {
            skipped += 1
            continue
         }

         const fail: Fail = (field, message) => {
            failedRows.add(rowNo)
            errors.push({ row: rowNo, field, message })
         }

         const doc: any = structuredClone(spec.base)
         for (const c of importable) {
            const raw = clean(cells[c.key])
            if (!raw) {
               if (c.required && !missing.has(c.key)) fail(c.key, `${c.label} is required`)
               continue
            }
            const read = readCell(c, raw, reading)
            if (read.error) fail(c.key, read.error)
            else setPath(doc, c.path, read.value)
         }

         // §12: the Locations list is the single source of truth for where a
         // listing may be sold — both ends of a route — and a spreadsheet is
         // not a way round it.
         const serviced = (field: string, typed: string, put: (name: string) => void) => {
            const place: any = places.get(typed.trim().toLowerCase())
            if (place) put(place.name) // the spelling the list uses
            if (!typed || !spec.vertical) return
            if (!place) {
               fail(field, `${typed} is not in your serviced locations. Add it under Locations first.`)
            } else if (!place.isActive) {
               fail(field, `${place.name} is switched off in Locations. Switch it back on first.`)
            } else if (!place.servesVerticals?.includes(spec.vertical)) {
               fail(field, `${place.name} is not set up for ${spec.label.toLowerCase()}. Tick it under Locations first.`)
            }
         }
         serviced('city', String(doc.city ?? ''), (name) => (doc.city = name))
         if (doc.attributes?.destination !== undefined) {
            serviced('destination', String(doc.attributes.destination), (name) => (doc.attributes.destination = name))
         }

         // A supplier by its name under Suppliers — never a new one made up by a typo.
         if (doc.supplier !== undefined) {
            const found: any = suppliers.get(String(doc.supplier).trim().toLowerCase())
            if (!found) {
               fail('supplier', `${doc.supplier} is not in your suppliers. Add it under Suppliers first.`)
            } else {
               doc.supplier = found._id
               // A route's operator is its agency's name, a car's its rental
               // company's, as in the panel.
               if (doc.attributes && ['BUS', 'FLIGHT', 'CAR'].includes(doc.vertical)) {
                  doc.attributes.operator = found.name
               }
            }
         }

         spec.finish?.(doc, fail)
         prepared.push({ rowNo, doc })
      }

      const toCreate = prepared.filter((p) => !failedRows.has(p.rowNo))
      const report = {
         rows: records.length,
         validRows: toCreate.length,
         skipped,
         errors,
         notes,
         ignoredColumns,
         canCommit: errors.length === 0 && toCreate.length > 0,
      }

      // Dry run by default — report first, write only when asked.
      if (!commit) {
         return sendResponse(res, 200, 'Validation report', { dryRun: true, ...report })
      }
      if (errors.length) {
         return next(new AppError('Fix the reported errors before importing', 400))
      }
      if (!toCreate.length) {
         return next(new AppError('Every row in that file is already in the system', 400))
      }

      const docs = toCreate.map(({ doc }) => {
         const base =
            slugify([getPath(doc, spec.titlePath), doc.city].filter(Boolean).join('-'), {
               lower: true,
               strict: true,
            }) || spec.file
         let slug = base
         for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
         taken.add(slug)
         return {
            ...doc,
            slug,
            // Created, not yet published: the office reviews and publishes.
            status: LISTING_STATUS.INACTIVE,
            createdBy: (req as any).admin._id,
         }
      })

      // §2.2: transactional — every row lands or none does.
      const session = await spec.model.startSession()
      let created = 0
      try {
         await session.withTransaction(async () => {
            created = (await spec.model.insertMany(docs, { session })).length
         })
      } catch (err: any) {
         return next(new AppError(`Nothing was imported: ${err.message}`, 400))
      } finally {
         await session.endSession()
      }

      // One entry for the batch — a thousand rows of noise would bury the signal.
      await recordAudit(req, {
         action: AUDIT_ACTIONS.CREATE,
         entityType: spec.entityType,
         after: { imported: created, group },
         reason: `CSV import of ${created} ${spec.label.toLowerCase()}`,
      })

      return sendResponse(res, 201, `${created} imported as inactive`, {
         dryRun: false,
         ...report,
         created,
      })
   }
)
