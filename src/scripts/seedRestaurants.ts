/**
 * Restaurants and menus for development.
 *
 *   npm run seed:restaurants
 *
 * A separate script from seed:catalogue rather than another section inside it:
 * that one already deletes five collections, and a restaurant seed that also
 * wiped listings and hotels every time you wanted a new dish would be a trap.
 * This touches only `restaurants` and `menuitems`.
 *
 * SAFETY: refuses to run against anything that is not a local database unless
 * SEED_CONFIRM=1 is set explicitly — "seed the dev data" should never be one
 * stale shell variable away from wiping a live cluster.
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import { LISTING_STATUS, MENU_SECTIONS } from '../constants/domain.constants'
import { MenuItem, Restaurant } from '../model/restaurantModel'

/** Minor units. USD is the reporting base; CDF is typed, never converted. */
const usd = (dollars: number) => Math.round(dollars * 100)
const cdf = (francs: number) => Math.round(francs)

type Dish = {
   section: string
   fr: string
   en: string
   descFr: string
   descEn: string
   sell: number
   cost: number
   available?: boolean
}

const RESTAURANTS: {
   slug: string
   fr: string
   en: string
   city: string
   address: string
   cuisines: string[]
   descFr: string
   descEn: string
   hours: string
   prep: number
   rating: number
   reviews: number
   zones: { name: string; fee: number; feeCdf: number; min?: number; eta: number }[]
   menu: Dish[]
}[] = [
   {
      slug: 'chez-flore-gombe',
      fr: 'Chez Flore',
      en: 'Chez Flore',
      city: 'Kinshasa',
      address: '14, avenue Colonel Lukusa, Gombe',
      cuisines: ['Congolais', 'Grillades'],
      descFr:
         "Cuisine congolaise de famille à Gombe : moambe mijotée au feu doux, poisson du fleuve grillé et fufu pilé le matin même.",
      descEn:
         'Family Congolese cooking in Gombe: slow-simmered moambe, grilled river fish and fufu pounded the same morning.',
      hours: 'Lun–Sam 11h00–22h00, Dim 12h00–20h00',
      prep: 25,
      rating: 4.7,
      reviews: 212,
      zones: [
         { name: 'Gombe', fee: 3, feeCdf: 8500, eta: 30 },
         { name: 'Lingwala', fee: 4.5, feeCdf: 12500, min: 15, eta: 45 },
         { name: 'Kintambo', fee: 6, feeCdf: 17000, min: 20, eta: 60 },
      ],
      menu: [
         {
            section: MENU_SECTIONS.STARTER,
            fr: 'Beignets de crevettes',
            en: 'Prawn fritters',
            descFr: 'Crevettes du fleuve, pâte légère, sauce pili-pili maison.',
            descEn: 'River prawns in a light batter with house pili-pili sauce.',
            sell: 7,
            cost: 3.2,
         },
         {
            section: MENU_SECTIONS.STARTER,
            fr: 'Salade d’avocat et tomate',
            en: 'Avocado and tomato salad',
            descFr: 'Avocat de Kisantu, tomate, oignon rouge, citron vert.',
            descEn: 'Kisantu avocado, tomato, red onion, lime.',
            sell: 5,
            cost: 1.8,
         },
         {
            section: MENU_SECTIONS.MAIN,
            fr: 'Poulet à la moambe',
            en: 'Moambe chicken',
            descFr:
               'Poulet fermier mijoté dans la pulpe de noix de palme, servi avec riz ou fufu.',
            descEn: 'Free-range chicken simmered in palm-nut pulp, served with rice or fufu.',
            sell: 12,
            cost: 5.4,
         },
         {
            section: MENU_SECTIONS.MAIN,
            fr: 'Capitaine grillé',
            en: 'Grilled capitaine',
            descFr: 'Filet de capitaine du fleuve Congo, braisé, sauce tomate épicée.',
            descEn: 'Congo river capitaine fillet, braised, with a spiced tomato sauce.',
            sell: 16,
            cost: 7.5,
         },
         {
            section: MENU_SECTIONS.MAIN,
            fr: 'Liboke de tilapia',
            en: 'Tilapia liboke',
            descFr: 'Tilapia cuit en feuille de bananier avec oignons et piment doux.',
            descEn: 'Tilapia steamed in banana leaf with onion and mild chilli.',
            sell: 13,
            cost: 6,
            available: false,
         },
         {
            section: MENU_SECTIONS.SIDE,
            fr: 'Fufu',
            en: 'Fufu',
            descFr: 'Pilé le matin même, servi chaud.',
            descEn: 'Pounded the same morning, served warm.',
            sell: 3,
            cost: 0.9,
         },
         {
            section: MENU_SECTIONS.SIDE,
            fr: 'Pondu',
            en: 'Cassava leaves',
            descFr: 'Feuilles de manioc au lait de coco et poisson fumé.',
            descEn: 'Cassava leaves with coconut milk and smoked fish.',
            sell: 4.5,
            cost: 1.6,
         },
         {
            section: MENU_SECTIONS.DESSERT,
            fr: 'Beignets de banane',
            en: 'Banana fritters',
            descFr: 'Bananes plantains mûres, sucre de canne.',
            descEn: 'Ripe plantain, cane sugar.',
            sell: 4,
            cost: 1.2,
         },
         {
            section: MENU_SECTIONS.DRINK,
            fr: 'Jus de gingembre',
            en: 'Ginger juice',
            descFr: 'Pressé maison, servi très frais.',
            descEn: 'Pressed in house, served very cold.',
            sell: 3,
            cost: 0.8,
         },
         {
            section: MENU_SECTIONS.DRINK,
            fr: 'Primus 33cl',
            en: 'Primus 33cl',
            descFr: 'Bière blonde, bien fraîche.',
            descEn: 'Lager, well chilled.',
            sell: 2.5,
            cost: 1.1,
         },
      ],
   },
   {
      slug: 'le-katanga-grill',
      fr: 'Le Katanga Grill',
      en: 'Le Katanga Grill',
      city: 'Lubumbashi',
      address: '58, avenue Mobutu, Lubumbashi',
      cuisines: ['Grillades', 'Européen'],
      descFr:
         'Braaï katangais et cuisine continentale : côtes de bœuf au feu de bois, brochettes et frites maison.',
      descEn:
         'Katangan braai and continental cooking: wood-fired beef ribs, skewers and hand-cut chips.',
      hours: 'Tous les jours 12h00–23h00',
      prep: 35,
      rating: 4.5,
      reviews: 168,
      zones: [
         { name: 'Centre-ville', fee: 2.5, feeCdf: 7000, eta: 30 },
         { name: 'Golf', fee: 4, feeCdf: 11000, min: 12, eta: 45 },
      ],
      menu: [
         {
            section: MENU_SECTIONS.STARTER,
            fr: 'Soupe de poulet',
            en: 'Chicken soup',
            descFr: 'Bouillon clair, légumes du marché.',
            descEn: 'Clear broth with market vegetables.',
            sell: 5,
            cost: 1.9,
         },
         {
            section: MENU_SECTIONS.MAIN,
            fr: 'Côte de bœuf au feu de bois',
            en: 'Wood-fired beef rib',
            descFr: 'Bœuf du Katanga, 400 g, sauce au poivre.',
            descEn: 'Katanga beef, 400g, pepper sauce.',
            sell: 22,
            cost: 11,
         },
         {
            section: MENU_SECTIONS.MAIN,
            fr: 'Brochettes de chèvre',
            en: 'Goat skewers',
            descFr: 'Marinées 24 heures, servies avec pili-pili.',
            descEn: 'Marinated 24 hours, served with pili-pili.',
            sell: 11,
            cost: 4.8,
         },
         {
            section: MENU_SECTIONS.MAIN,
            fr: 'Poulet braisé entier',
            en: 'Whole braised chicken',
            descFr: 'Poulet entier braisé, ail et citron.',
            descEn: 'Whole braised chicken, garlic and lemon.',
            sell: 18,
            cost: 8.2,
         },
         {
            section: MENU_SECTIONS.SIDE,
            fr: 'Frites maison',
            en: 'Hand-cut chips',
            descFr: 'Pommes de terre du Katanga, double cuisson.',
            descEn: 'Katanga potatoes, twice cooked.',
            sell: 4,
            cost: 1.3,
         },
         {
            section: MENU_SECTIONS.SIDE,
            fr: 'Riz pilaf',
            en: 'Pilaf rice',
            descFr: 'Riz parfumé aux épices douces.',
            descEn: 'Rice with mild spices.',
            sell: 3.5,
            cost: 1,
         },
         {
            section: MENU_SECTIONS.DESSERT,
            fr: 'Ananas rôti',
            en: 'Roasted pineapple',
            descFr: 'Ananas caramélisé, glace vanille.',
            descEn: 'Caramelised pineapple with vanilla ice cream.',
            sell: 5,
            cost: 1.7,
         },
         {
            section: MENU_SECTIONS.DRINK,
            fr: 'Eau minérale 1L',
            en: 'Mineral water 1L',
            descFr: 'Bouteille fraîche.',
            descEn: 'Chilled bottle.',
            sell: 1.5,
            cost: 0.5,
         },
      ],
   },
   {
      slug: 'kivu-lakeside-kitchen',
      fr: 'Kivu Lakeside Kitchen',
      en: 'Kivu Lakeside Kitchen',
      city: 'Goma',
      address: "22, avenue du Lac, Goma",
      cuisines: ['Poisson', 'Congolais'],
      descFr:
         'Poissons du lac Kivu préparés à la commande, terrasse sur l’eau et service de livraison en ville.',
      descEn:
         'Lake Kivu fish cooked to order, a terrace over the water, and delivery across town.',
      hours: 'Mar–Dim 11h30–22h00',
      prep: 30,
      rating: 4.8,
      reviews: 96,
      zones: [
         { name: 'Himbi', fee: 3, feeCdf: 8500, eta: 30 },
         { name: 'Katindo', fee: 4, feeCdf: 11000, min: 10, eta: 40 },
      ],
      menu: [
         {
            section: MENU_SECTIONS.STARTER,
            fr: 'Sambaza frits',
            en: 'Fried sambaza',
            descFr: 'Petits poissons du lac, frits, citron.',
            descEn: 'Small lake fish, fried, with lemon.',
            sell: 6,
            cost: 2.2,
         },
         {
            section: MENU_SECTIONS.MAIN,
            fr: 'Tilapia entier grillé',
            en: 'Whole grilled tilapia',
            descFr: 'Tilapia du Kivu, braisé, légumes sautés.',
            descEn: 'Kivu tilapia, braised, with sautéed vegetables.',
            sell: 14,
            cost: 6.4,
         },
         {
            section: MENU_SECTIONS.MAIN,
            fr: 'Riz aux crevettes du lac',
            en: 'Lake prawn rice',
            descFr: 'Riz parfumé, crevettes, tomates fraîches.',
            descEn: 'Fragrant rice, prawns, fresh tomato.',
            sell: 12,
            cost: 5.1,
         },
         {
            section: MENU_SECTIONS.SIDE,
            fr: 'Makemba',
            en: 'Fried plantain',
            descFr: 'Bananes plantains frites.',
            descEn: 'Fried plantain.',
            sell: 3,
            cost: 0.9,
         },
         {
            section: MENU_SECTIONS.DESSERT,
            fr: 'Salade de fruits',
            en: 'Fruit salad',
            descFr: 'Fruits de saison du marché de Goma.',
            descEn: 'Seasonal fruit from Goma market.',
            sell: 4,
            cost: 1.4,
         },
         {
            section: MENU_SECTIONS.DRINK,
            fr: 'Jus de maracuja',
            en: 'Passion fruit juice',
            descFr: 'Pressé du jour.',
            descEn: 'Pressed today.',
            sell: 3,
            cost: 0.9,
         },
      ],
   },
]

/**
 * Placeholder imagery already in the repo. A published restaurant needs at
 * least one image (publishBlockers enforces it), and pointing at files that
 * exist is what keeps the seeded catalogue from rendering broken cards.
 */
const IMAGES = ['/img/banner-1.svg', '/img/banner-2.svg']

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

   await Promise.all([Restaurant.deleteMany({}), MenuItem.deleteMany({})])

   let dishes = 0
   for (const r of RESTAURANTS) {
      const restaurant = await Restaurant.create({
         name: { fr: r.fr, en: r.en },
         slug: r.slug,
         description: { fr: r.descFr, en: r.descEn },
         status: LISTING_STATUS.PUBLISHED,
         cuisines: r.cuisines,
         address: r.address,
         city: r.city,
         country: 'CD',
         images: IMAGES,
         openingHours: r.hours,
         prepTimeMinutes: r.prep,
         rating: r.rating,
         reviewCount: r.reviews,
         deliveryZones: r.zones.map((z) => ({
            name: z.name,
            fee: { USD: usd(z.fee), CDF: cdf(z.feeCdf) },
            minOrder: z.min ? { USD: usd(z.min) } : undefined,
            etaMinutes: z.eta,
            isActive: true,
         })),
      })

      await MenuItem.insertMany(
         r.menu.map((d, i) => ({
            restaurant: restaurant._id,
            section: d.section,
            name: { fr: d.fr, en: d.en },
            description: { fr: d.descFr, en: d.descEn },
            // CDF alongside USD on every dish so a CDF checkout can actually
            // settle — one dish missing it would drop the whole order to USD.
            sellPrice: { USD: usd(d.sell), CDF: cdf(d.sell * 2800) },
            costPrice: { USD: usd(d.cost), CDF: cdf(d.cost * 2800) },
            isAvailable: d.available !== false,
            sortOrder: i,
            status: LISTING_STATUS.PUBLISHED,
         }))
      )
      dishes += r.menu.length
   }

   console.log(`seeded restaurants: ${RESTAURANTS.length}, menu items: ${dishes}`)
   await mongoose.disconnect()
}

run().catch((err) => {
   console.error(err.message)
   process.exit(1)
})
