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

export default router
