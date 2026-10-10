import { NextFunction, Request, Response } from 'express'
import { Model } from 'mongoose'
import slugify from 'slugify'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { LISTING_STATUS, VERTICALS } from '../../constants/domain.constants'
import { Hotel } from '../../model/hotelModel'
import { Listing } from '../../model/listingModel'
import { Location } from '../../model/locationModel'
import { Restaurant } from '../../model/restaurantModel'
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

/** What the example row needs that only the database knows. */
interface TemplateContext {
   /** A city this kind of inventory can actually be saved against. */
   city: string
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

const PRICES: Column[] = [
   col('cost_price_usd', 'Cost price (USD)', 'money', 'costPrice.USD', '45.00',
      'What you pay the supplier for one. Never shown to customers.',
      { required: true, min: 0.01 }),
   col('sell_price_usd', 'Sell price (USD)', 'money', 'sellPrice.USD', '70.00',
      'What the customer pays for one. Must be above the cost price.',
      { required: true, min: 0.01 }),
   col('sell_price_cdf', 'Sell price (CDF)', 'money', 'sellPrice.CDF', '196000',
      'Only if you also sell it in francs. Blank means not sold in CDF — nothing is converted.',
      { min: 0.01 }),
   col('sell_price_eur', 'Sell price (EUR)', 'money', 'sellPrice.EUR', '64.00',
      'Only if you also sell it in euros.', { min: 0.01 }),
]

const quantity = (what: string, example: string) =>
   col('quantity', 'Quantity', 'int', 'quantityTotal', example,
      `How many ${what} you have to sell.`, { required: true, min: 1 })

const supplier = (example: string) =>
   col('supplier', 'Supplier', 'text', 'supplier', example,
      'Who you buy it from. For your own reports; customers never see it.', { max: 200 })

const VALID_FROM = col('valid_from', 'On sale from', 'datetime', 'validFrom',
   (c) => stamp(new Date(c.departs.getTime() - 30 * DAY)),
   'Optional. The first day it can be booked.')

/** In every export, read by no import. */
const REFERENCE: Column[] = [
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
   const cost = doc.costPrice?.USD ?? 0
   const sell = doc.sellPrice?.USD ?? 0
   if (cost && sell && sell <= cost) {
      fail('sell_price_usd', 'Sell price must be above the cost price')
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

const flight = (doc: any, fail: Fail) => {
   sellable(doc, fail)
   const [out, back] = doc.attributes?.segments ?? []
   if (!out) return // the missing cells have already been reported

   for (const [field, code] of [['origin', out.origin], ['destination', out.destination]]) {
      if (code && !/^[A-Z]{3}$/.test(code)) {
         fail(field, 'Must be a 3-letter airport code, like FIH')
      }
   }
   if (out.origin && out.origin === out.destination) {
      fail('destination', 'Must be different from the origin')
   }
   if (out.departsAt && out.arrivesAt && out.arrivesAt <= out.departsAt) {
      fail('arrives_at', 'Must be after the departure')
   }
   // The shared pair is what the catalogue sorts by and the nightly job
   // expires on. A flight that kept its time only on the segment never expired.
   doc.attributes.departsAt = out.departsAt
   doc.attributes.arrivesAt = out.arrivesAt

   if (back && Object.values(back).some(Boolean)) {
      if (!back.departsAt) {
         fail('return_departs_at', 'A return flight needs its departure time')
      } else if (out.departsAt && back.departsAt <= out.departsAt) {
         fail('return_departs_at', 'Must be after the outbound departure')
      }
      if (back.departsAt && back.arrivesAt && back.arrivesAt <= back.departsAt) {
         fail('return_arrives_at', 'Must be after the return departure')
      }
      // The way back is the way out, reversed.
      doc.attributes.segments = [
         out,
         { ...back, carrier: out.carrier, origin: out.destination, destination: out.origin },
      ]
      doc.attributes.tripType = 'RETURN'
   } else {
      doc.attributes.segments = [out]
      doc.attributes.tripType = 'ONE_WAY'
   }
}

const bus = (doc: any, fail: Fail) => {
   sellable(doc, fail)
   const { departsAt, arrivesAt } = doc.attributes ?? {}
   if (departsAt && arrivesAt && arrivesAt <= departsAt) {
      fail('arrives_at', 'Must be after the departure')
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
      after: 'Then, in the panel: add photos, the room types and their nightly prices, and publish.',
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
      singular: 'flight',
      file: 'flights',
      base: { vertical: VERTICALS.FLIGHT },
      columns: [
         ...titled('Kinshasa → Lubumbashi, aller simple', 'Kinshasa → Lubumbashi, one way'),
         SERVICED_CITY,
         ...described(
            'Vol direct, un bagage en soute inclus.',
            'Direct flight, one checked bag included.'
         ),
         col('carrier', 'Airline', 'text', 'attributes.segments.0.carrier', 'Congo Airways',
            'The airline operating the flight.', { required: true, max: 120 }),
         col('flight_number', 'Flight number', 'text', 'attributes.segments.0.flightNumber',
            '8Z 101', 'As printed on the ticket.', { max: 20 }),
         col('origin', 'From (airport code)', 'text', 'attributes.segments.0.origin', 'FIH',
            'The 3-letter code of the departure airport.', { required: true, upper: true }),
         col('destination', 'To (airport code)', 'text', 'attributes.segments.0.destination',
            'FBM', 'The 3-letter code of the arrival airport.', { required: true, upper: true }),
         col('departs_at', 'Departs', 'datetime', 'attributes.segments.0.departsAt',
            (c) => stamp(c.departs), 'Date and time of departure.', { required: true }),
         col('arrives_at', 'Arrives', 'datetime', 'attributes.segments.0.arrivesAt',
            (c) => stamp(new Date(c.departs.getTime() + 2.5 * 3600000)),
            'Date and time of arrival.'),
         col('return_flight_number', 'Return flight number', 'text',
            'attributes.segments.1.flightNumber', '8Z 102',
            'Fill the three return columns for a return ticket; leave them blank for one way.',
            { max: 20 }),
         col('return_departs_at', 'Return departs', 'datetime',
            'attributes.segments.1.departsAt',
            (c) => stamp(new Date(c.departs.getTime() + 7 * DAY)),
            'Date and time the return flight leaves.'),
         col('return_arrives_at', 'Return arrives', 'datetime',
            'attributes.segments.1.arrivesAt',
            (c) => stamp(new Date(c.departs.getTime() + 7 * DAY + 2.5 * 3600000)),
            'Date and time the return flight lands.'),
         col('cabin', 'Cabin', 'enum', 'attributes.cabin', 'ECONOMY', 'The class of travel.',
            { options: ['ECONOMY', 'PREMIUM', 'BUSINESS', 'FIRST'] }),
         col('baggage', 'Baggage', 'text', 'attributes.baggage',
            '1 bagage en soute 23 kg + 1 bagage cabine', 'What is included.', { max: 300 }),
         col('fare_rules', 'Fare rules', 'text', 'attributes.fareRules',
            'Non modifiable. Non remboursable.', 'Change and refund conditions.', { max: 1000 }),
         ...PRICES,
         quantity('seats', '20'),
         supplier('Congo Airways'),
         SOLD,
         ...REFERENCE,
      ],
      finish: flight,
      after: 'Then, in the panel: add a photo and publish.',
   },

   BUS: {
      ...listing(VERTICALS.BUS),
      label: 'Bus',
      singular: 'bus service',
      file: 'bus',
      base: { vertical: VERTICALS.BUS },
      columns: [
         ...titled('Kinshasa → Matadi, Transco', 'Kinshasa → Matadi, Transco'),
         SERVICED_CITY,
         ...described('Départ quotidien, car climatisé.', 'Daily departure, air-conditioned coach.'),
         col('operator', 'Operator', 'text', 'attributes.operator', 'Transco',
            'The bus company.', { required: true, max: 120 }),
         col('departs_at', 'Departs', 'datetime', 'attributes.departsAt',
            (c) => stamp(c.departs), 'Date and time of departure.'),
         col('arrives_at', 'Arrives', 'datetime', 'attributes.arrivesAt',
            (c) => stamp(new Date(c.departs.getTime() + 6 * 3600000)),
            'Date and time of arrival.'),
         col('vehicle_class', 'Vehicle class', 'text', 'attributes.vehicleClass', 'Climatisé',
            'For example Climatisé, VIP, Standard.', { max: 120 }),
         col('route_stops', 'Stops on the way', 'list', 'attributes.routeStops',
            'Kisantu | Mbanza-Ngungu', 'Towns the bus stops in, separated by a | bar.'),
         ...PRICES,
         quantity('seats', '45'),
         VALID_FROM,
         supplier('Transco'),
         SOLD,
         ...REFERENCE,
      ],
      finish: bus,
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
         col('category', 'Category', 'text', 'attributes.category', '4x4',
            'For example 4x4, Berline, Minibus.', { max: 80 }),
         col('transmission', 'Gearbox', 'enum', 'attributes.transmission', 'AUTOMATIC',
            'How it is driven.', { options: ['MANUAL', 'AUTOMATIC'] }),
         col('with_driver', 'With driver', 'bool', 'attributes.withDriver', 'yes',
            'yes if a driver comes with the car, no if the customer drives.'),
         col('deposit_usd', 'Deposit (USD)', 'money', 'attributes.deposit', '300.00',
            'Held against damage. Leave blank for none.', { min: 0 }),
         col('mileage_limit', 'Mileage limit', 'text', 'attributes.mileageLimit',
            '200 km / jour', 'As you would tell the customer.', { max: 120 }),
         col('pickup_locations', 'Pick-up points', 'list', 'attributes.pickupLocations',
            'Aéroport de Ndjili | Centre-ville', 'Where the car can be collected, separated by a | bar.'),
         col('insurance_terms', 'Insurance', 'text', 'attributes.insuranceTerms',
            'Assurance au tiers, franchise 500 $', 'What cover is included.', { max: 500 }),
         ...PRICES,
         quantity('cars', '3'),
         VALID_FROM,
         supplier('Kinshasa Fleet'),
         SOLD,
         ...REFERENCE,
      ],
      finish: sellable,
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
         col('child_price_usd', 'Child price (USD)', 'money', 'attributes.childPrice', '35.00',
            'Leave blank if children pay the full price.', { min: 0 }),
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
      base: { vertical: VERTICALS.PROPERTY, quantityTotal: 1, costPrice: { USD: 0 } },
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
         col('price_usd', 'Price (USD)', 'money', 'sellPrice.USD', '250000.00',
            'The asking price or the monthly rent.', { required: true, min: 0.01 }),
         col('price_cdf', 'Price (CDF)', 'money', 'sellPrice.CDF', '',
            'Only if you also quote it in francs.', { min: 0.01 }),
         col('price_eur', 'Price (EUR)', 'money', 'sellPrice.EUR', '',
            'Only if you also quote it in euros.', { min: 0.01 }),
         col('bedrooms', 'Bedrooms', 'int', 'attributes.bedrooms', '4', 'Number of bedrooms.',
            { min: 0 }),
         col('bathrooms', 'Bathrooms', 'int', 'attributes.bathrooms', '3',
            'Number of bathrooms.', { min: 0 }),
         col('area_sqm', 'Living area (m²)', 'decimal', 'attributes.areaSqm', '320',
            'Floor area in square metres.', { min: 0 }),
         col('plot_size_sqm', 'Plot (m²)', 'decimal', 'attributes.plotSizeSqm', '900',
            'Size of the land in square metres.', { min: 0 }),
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
 * NUL would make the driver throw; a leading apostrophe before = + - @ is the
 * formula guard an export put there (see `inert`), not part of the value.
 */
const clean = (v: unknown) =>
   String(v ?? '')
      .replace(/\0/g, '')
      .trim()
      .replace(/^'(?=[=+\-@])/, '')

/**
 * `1 234,50` and `1,234.50` are the same amount written by two spreadsheets.
 * Which one a comma means depends on the file. Where cells are split by `;`
 * it is the decimal mark, as French Excel writes it. Anywhere else it groups
 * thousands — unless it is plainly a decimal (`45,5`, `45,50`), which is what
 * someone typing by hand into any file means by it.
 */
const toNumber = (raw: string, decimalComma: boolean): number | null => {
   // \s covers the no-break spaces French formatting groups digits with.
   let t = raw.replace(/\s/g, '')
   if (decimalComma || /^-?\d+,\d{1,2}$/.test(t)) {
      if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
   } else {
      t = t.replace(/,/g, '')
   }
   return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null
}

/**
 * `2026-12-24 08:00`, `2026-12-24T08:00` or `24/12/2026 08:00`, the time
 * optional. Day comes first when the year is last, as it is written here.
 * Read as UTC, like every other date in the system, so a file means the same
 * thing whichever server opens it.
 */
const toDate = (raw: string): Date | null => {
   const t = raw.trim().replace('T', ' ')
   const time = '(?:\\s+(\\d{1,2}):(\\d{2})(?::\\d{2}(?:\\.\\d+)?)?)?Z?'
   let m = t.match(new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${time}$`))
   let y: string, mo: string, d: string
   if (m) [, y, mo, d] = m
   else {
      m = t.match(new RegExp(`^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})${time}$`))
      if (!m) return null
      ;[, d, mo, y] = m
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

const YES = ['yes', 'y', 'oui', 'o', 'true', 'vrai', '1']
const NO = ['no', 'n', 'non', 'false', 'faux', '0']

const between = (n: number, c: Column): string | null => {
   if (c.min !== undefined && n < c.min) {
      return c.min > 0 && c.min < 1 ? 'Must be more than zero' : `Must be ${c.min} or more`
   }
   if (c.max !== undefined && n > c.max) return `Must be ${c.max} or less`
   return null
}

const readCell = (
   c: Column,
   raw: string,
   decimalComma: boolean
): { value?: unknown; error?: string } => {
   switch (c.kind) {
      case 'text': {
         const text = raw.slice(0, c.max ?? 500)
         return { value: c.upper ? text.toUpperCase() : text }
      }
      case 'int': {
         const n = toNumber(raw, decimalComma)
         if (n === null || !Number.isInteger(n)) return { error: 'Must be a whole number' }
         const out = between(n, c)
         return out ? { error: out } : { value: n }
      }
      case 'decimal': {
         const n = toNumber(raw, decimalComma)
         if (n === null) return { error: 'Must be a number' }
         const out = between(n, c)
         return out ? { error: out } : { value: n }
      }
      case 'money': {
         const n = toNumber(raw, decimalComma)
         if (n === null || n < 0) return { error: 'Must be an amount, like 45.50' }
         const out = between(n, c)
         // Minor units on the record, exactly as the panel's price boxes store them.
         return out ? { error: out } : { value: Math.round(n * 100) }
      }
      case 'datetime': {
         const d = toDate(raw)
         return d ? { value: d } : { error: 'Must be a date, like 2026-12-24 08:00' }
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
   }
}

/**
 * A cell that starts with = + - or @ is run as a formula by a spreadsheet.
 * Text never should be, whoever typed it — prefixed, it is shown as written.
 */
const inert = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s)

type Delimiter = ',' | ';'

/** A number the way the reader's spreadsheet expects to be handed one. */
const localNumber = (n: string, delimiter: Delimiter) =>
   delimiter === ';' ? n.replace('.', ',') : n

const writeCell = (c: Column, doc: any, delimiter: Delimiter): string => {
   const v = getPath(doc, c.path)
   if (v === undefined || v === null || v === '') return ''
   switch (c.kind) {
      case 'money':
         return localNumber((Number(v) / 100).toFixed(2), delimiter)
      case 'decimal':
         return localNumber(String(v), delimiter)
      case 'int':
         return String(v)
      case 'datetime':
         return stamp(new Date(v))
      case 'list':
         return inert((v as string[]).join(' | '))
      case 'bool':
         return v ? 'yes' : 'no'
      case 'phone':
      case 'time':
      case 'enum':
         return String(v)
      default:
         return inert(String(v))
   }
}

const exampleOf = (c: Column, ctx: TemplateContext, delimiter: Delimiter = ',') => {
   const text = typeof c.example === 'function' ? c.example(ctx) : c.example
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

/** RFC 4180, with the separator worked out rather than assumed. */
const parseCsv = (input: string) => {
   let text = input.replace(/^\uFEFF/, '')
   // Excel's own hint line, when someone saved the file with one.
   const hint = text.match(/^sep=(.)\r?\n/i)
   if (hint) text = text.slice(hint[0].length)
   const separator = hint ? hint[1] : detectSeparator(text)

   const rows: string[][] = []
   let field = ''
   let row: string[] = []
   let inQuotes = false
   for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inQuotes) {
         if (c === '"' && text[i + 1] === '"') {
            field += '"'
            i++
         } else if (c === '"') inQuotes = false
         else field += c
      } else if (c === '"') inQuotes = true
      else if (c === separator) {
         row.push(field)
         field = ''
      } else if (c === '\n') {
         row.push(field)
         rows.push(row)
         row = []
         field = ''
      } else if (c !== '\r') field += c
   }
   if (field || row.length) {
      row.push(field)
      rows.push(row)
   }

   const header = (rows[0] ?? []).map(normaliseHeader)
   const records = rows
      .slice(1)
      // Numbered as the spreadsheet numbers them: the header is row 1.
      .map((cells, i) => ({ rowNo: i + 2, cells }))
      .filter((r) => r.cells.some((c) => c.trim()))
      .map((r) => ({
         rowNo: r.rowNo,
         cells: Object.fromEntries(header.map((h, i) => [h, r.cells[i] ?? ''])) as Record<
            string,
            string
         >,
      }))
   return { header: header.filter(Boolean), records, decimalComma: separator === ';' }
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
   const place = await Location.findOne({
      isActive: true,
      ...(spec.vertical ? { servesVerticals: spec.vertical } : {}),
   })
      .sort({ sortOrder: 1, name: 1 })
      .select('name')
      .lean()
   const soon = new Date(Date.now() + 30 * DAY)
   return {
      city: (place as any)?.name ?? 'Kinshasa',
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
 * Without `commit` this validates and reports, writing nothing.
 */
export const importCsv = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const { group, spec } = groupOf(req)
      const { csv, commit } = req.body ?? {}
      if (!csv || typeof csv !== 'string') {
         return next(new AppError('Choose a CSV file to import', 400))
      }

      const { header, records, decimalComma } = parseCsv(csv)
      if (!records.length) {
         return next(new AppError('That file has no rows under its header', 400))
      }
      if (records.length > MAX_IMPORT_ROWS) {
         return next(
            new AppError(`An import is limited to ${MAX_IMPORT_ROWS} rows per file`, 400)
         )
      }

      const errors: { row: number; field: string; message: string }[] = []
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
            const read = readCell(c, raw, decimalComma)
            if (read.error) fail(c.key, read.error)
            else setPath(doc, c.path, read.value)
         }

         // §12: the Locations list is the single source of truth for where a
         // listing may be sold, and a spreadsheet is not a way round it.
         const typed = String(doc.city ?? '')
         const place: any = places.get(typed.trim().toLowerCase())
         if (place) doc.city = place.name // the spelling the list uses
         if (typed && spec.vertical) {
            if (!place) {
               fail('city', `${typed} is not in your serviced locations. Add it under Locations first.`)
            } else if (!place.isActive) {
               fail('city', `${place.name} is switched off in Locations. Switch it back on first.`)
            } else if (!place.servesVerticals?.includes(spec.vertical)) {
               fail('city', `${place.name} is not set up for ${spec.label.toLowerCase()}. Tick it under Locations first.`)
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
