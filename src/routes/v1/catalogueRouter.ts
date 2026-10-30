import express from 'express'
import rateLimit from 'express-rate-limit'
import {
   getFacets,
   getHomeFeed,
   getHotel,
   getListing,
   getSlugs,
   searchHotels,
   searchListings,
} from '../../controllers/public/catalogueController'
import {
   getRestaurant,
   searchRestaurants,
} from '../../controllers/public/restaurantController'
import {
   getSiteContact,
   getSiteContentPublic,
   getSiteCurrencies,
} from '../../controllers/public/siteController'
import { listPartners } from '../../controllers/public/partnerController'
import { createEnquiry } from '../../controllers/public/enquiryController'
import { getPolicy } from '../../controllers/public/policyController'
import { listLocations, listRoutes } from '../../controllers/public/locationController'
import {
   createOrder,
   getOrder,
   getOrderDocument,
} from '../../controllers/public/orderController'
import {
   maxicashNotify,
   maxicashReturn,
   paymentOptions,
   paymentStatus,
   startPayment,
} from '../../controllers/public/paymentController'
import {
   deleteMe,
   registerDevice,
   unregisterDevice,
   login,
   logout,
   me,
   myOrders,
   requestOtp,
   resetPassword,
   updateMe,
   verifyOtp,
} from '../../controllers/public/customerAuthController'
import { protectCustomer } from '../../middleware/customerAuth'

const router = express.Router()

/**
 * §14.9 anti-scraping: the curated catalogue is the client's competitive asset,
 * so search is rate-limited harder than the rest of /api/v1. Combined with the
 * hard page-size cap in the controller and the absence of any bulk export, a
 * competitor cannot pull the catalogue in one pass.
 */
const searchLimiter = rateLimit({
   max: 120,
   windowMs: 5 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many searches, please slow down' },
})

/** Lead capture is stricter still — each one costs a callback. */
const enquiryLimiter = rateLimit({
   max: 10,
   windowMs: 60 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many requests, please try again later' },
})

/**
 * §8: catalogue reads are public and cacheable at the edge. Authenticated
 * routes elsewhere set `private, no-store` — these deliberately do not, because
 * they contain nothing customer-specific.
 */
const cacheable = (seconds: number) =>
   ((_req, res, next) => {
      res.set('Cache-Control', `public, max-age=60, s-maxage=${seconds}, stale-while-revalidate=600`)
      next()
   }) as express.RequestHandler

/**
 * What shows a price or a promotion: an office change reaches customers within
 * the minute. Browsers and the app always ask again; the edge keeps it 30 s.
 */
const priced: express.RequestHandler = (_req, res, next) => {
   res.set('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=30')
   next()
}

router.get('/catalogue/home', priced, getHomeFeed)
router.get('/catalogue/facets', cacheable(900), getFacets)

/**
 * Where we service. Cached hard — it changes when the office opens a city, not
 * per request, and the search box asks for it on every page.
 */
router.get('/locations', cacheable(900), listLocations)
router.get('/routes', cacheable(900), listRoutes)
router.get('/catalogue/slugs', cacheable(900), getSlugs)

router.get('/listings', searchLimiter, priced, searchListings)
router.get('/listings/:slug', priced, getListing)

router.get('/hotels', searchLimiter, priced, searchHotels)
router.get('/hotels/:slug', priced, getHotel)

// Restaurants. Same cache as hotels: prices and promotions, and a menu the
// kitchen can 86 an item on at any moment.
router.get('/restaurants', searchLimiter, priced, searchRestaurants)
router.get('/restaurants/:slug', priced, getRestaurant)

/**
 * Legal text, authored in the admin's content section. Cached hard: it changes
 * a few times a year and every page footer links to it.
 */
// Contact details change about once a year, so a long cache; the admin edit
// is not expected to appear on the site within the minute.
router.get('/site/contact', cacheable(900), getSiteContact)
// The site's editable wording. A shorter cache than contact details: someone
// who has just changed a headline is waiting to see it.
router.get('/site/content', cacheable(300), getSiteContentPublic)
// A short cache: a rate the office has just set should reach the pickers in
// about the minute every server takes to re-read it.
router.get('/site/currencies', cacheable(60), getSiteCurrencies)
// The homepage's partner logos: edited from the panel like the wording above.
router.get('/partners', cacheable(300), listPartners)

router.get('/policies/:kind', cacheable(900), getPolicy)

router.post('/enquiries', enquiryLimiter, createEnquiry)

/**
 * Checkout (§4). Writes are limited harder than reads: each one takes stock,
 * and a loop hammering create would hold the catalogue hostage even though
 * every hold expires. Reads by reference are limited too — the reference is
 * the read capability, so this is the surface a guesser would attack.
 */
const checkoutLimiter = rateLimit({
   max: 20,
   windowMs: 60 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many checkout attempts, please try again later' },
})

const orderReadLimiter = rateLimit({
   max: 60,
   windowMs: 15 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many requests' },
})

/**
 * Sign-in by one-time code. Limited hard: each request sends an SMS to a number
 * the caller chose, so an unlimited endpoint is a way to bill us for harassing
 * a stranger's handset.
 */
const otpLimiter = rateLimit({
   max: 10,
   windowMs: 60 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many code requests, please try again later' },
})

/**
 * Password sign-in costs us nothing to serve, so it is limited for the other
 * reason: it is the one endpoint where guessing pays off. Twenty tries an hour
 * per IP leaves a real customer with a bad memory plenty of room and makes a
 * dictionary run pointless.
 */
const loginLimiter = rateLimit({
   max: 20,
   windowMs: 60 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many sign-in attempts, please try again later' },
})

router.post('/auth/otp/request', otpLimiter, requestOtp)
router.post('/auth/otp/verify', otpLimiter, verifyOtp)
router.post('/auth/login', loginLimiter, login)
router.post('/auth/password/reset', otpLimiter, resetPassword)
router.post('/auth/logout', logout)
router.get('/auth/me', protectCustomer, me)
router.patch('/auth/me', protectCustomer, updateMe)
router.delete('/auth/me', protectCustomer, deleteMe)

// §8: never cache an authenticated response.
const privateOnly: express.RequestHandler = (_req, res, next) => {
   res.set('Cache-Control', 'private, no-store, max-age=0')
   next()
}
router.get('/me/orders', privateOnly, protectCustomer, myOrders)
// Push notifications for the app: one entry per install, signed-in only.
router.post('/me/devices', protectCustomer, registerDevice)
router.delete('/me/devices', protectCustomer, unregisterDevice)

router.post('/orders', checkoutLimiter, createOrder)
/** Whether online payment can be offered: the website and the app ask this instead of carrying a switch each. */
router.get('/payments/options', paymentOptions)

/**
 * Confirms cash on an order, or opens a payment at MaxiCash. Rate-limited with
 * checkout because each online call opens a transaction there. With online
 * payment switched off, anything but cash is refused with CASH_ONLY.
 */
router.post('/orders/:reference/pay', checkoutLimiter, startPayment)

/**
 * MaxiCash's own call, on the address made for one attempt on one order.
 *
 * Deliberately NOT behind `checkoutLimiter`: throttling a provider's repeats
 * would drop real settlements. It still gets a generous ceiling so it cannot
 * be used as an amplifier.
 *
 * Every method: MaxiCash does not say which it uses, and a settlement
 * notification silently 404ing is the worst possible failure here.
 */
const webhookLimiter = rateLimit({
   max: 600,
   windowMs: 15 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { received: false },
})
router.all('/payments/maxicash/notify/:token', webhookLimiter, maxicashNotify)

/** The customer's browser, back from MaxiCash's page: says which booking, settles nothing. */
router.post('/payments/maxicash/return', orderReadLimiter, maxicashReturn)

/** What the return screen polls; reports the order's own paymentStatus. */
router.get('/orders/:reference/payment', orderReadLimiter, privateOnly, paymentStatus)
/** Exchanges a document id for a short-lived download link. */
router.get(
   '/orders/:reference/documents/:documentId',
   orderReadLimiter,
   privateOnly,
   getOrderDocument
)
// §8: an order is customer data. Never cacheable, never stored by a proxy.
router.get('/orders/:reference', orderReadLimiter, (_req, res, next) => {
   res.set('Cache-Control', 'private, no-store, max-age=0')
   next()
}, getOrder)

export default router
