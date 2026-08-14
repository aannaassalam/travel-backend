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
import { createEnquiry } from '../../controllers/public/enquiryController'
import { getPolicy } from '../../controllers/public/policyController'
import { listLocations, listRoutes } from '../../controllers/public/locationController'
import { createOrder, getOrder, payOrder } from '../../controllers/public/orderController'
import {
   logout,
   me,
   myOrders,
   requestOtp,
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

router.get('/catalogue/home', cacheable(300), getHomeFeed)
router.get('/catalogue/facets', cacheable(900), getFacets)

/**
 * Where we service. Cached hard — it changes when the office opens a city, not
 * per request, and the search box asks for it on every page.
 */
router.get('/locations', cacheable(900), listLocations)
router.get('/routes', cacheable(900), listRoutes)
router.get('/catalogue/slugs', cacheable(900), getSlugs)

router.get('/listings', searchLimiter, cacheable(120), searchListings)
router.get('/listings/:slug', cacheable(300), getListing)

router.get('/hotels', searchLimiter, cacheable(120), searchHotels)
router.get('/hotels/:slug', cacheable(300), getHotel)

/**
 * Legal text, authored in the admin's content section. Cached hard: it changes
 * a few times a year and every page footer links to it.
 */
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

router.post('/auth/otp/request', otpLimiter, requestOtp)
router.post('/auth/otp/verify', otpLimiter, verifyOtp)
router.post('/auth/logout', logout)
router.get('/auth/me', protectCustomer, me)

// §8: never cache an authenticated response.
const privateOnly: express.RequestHandler = (_req, res, next) => {
   res.set('Cache-Control', 'private, no-store, max-age=0')
   next()
}
router.get('/me/orders', privateOnly, protectCustomer, myOrders)

router.post('/orders', checkoutLimiter, createOrder)
router.post('/orders/:reference/pay', checkoutLimiter, payOrder)
// §8: an order is customer data. Never cacheable, never stored by a proxy.
router.get('/orders/:reference', orderReadLimiter, (_req, res, next) => {
   res.set('Cache-Control', 'private, no-store, max-age=0')
   next()
}, getOrder)

export default router
