import express from 'express'
import rateLimit from 'express-rate-limit'
import {
   alertTransfer,
   listCategories,
   listPlaces,
   quoteTransfer,
   rateTransfer,
} from '../../controllers/public/transferController'

const router = express.Router()

/**
 * Limited like the catalogue search: a quote calls the routing service and the
 * places box fires as the customer types, so a loop here costs a third party.
 */
const quoteLimiter = rateLimit({
   max: 120,
   windowMs: 5 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many requests, please slow down' },
})

/** Like lead capture: every rating and every alert is read by someone in the office. */
const postLimiter = rateLimit({
   max: 10,
   windowMs: 60 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many requests, please try again later' },
})

/** Nothing customer-specific: cacheable at the edge like the catalogue. */
const cacheable = (seconds: number) =>
   ((_req, res, next) => {
      res.set('Cache-Control', `public, max-age=60, s-maxage=${seconds}, stale-while-revalidate=600`)
      next()
   }) as express.RequestHandler

// §8: anything about a booking is customer data; never cached.
const privateOnly: express.RequestHandler = (_req, res, next) => {
   res.set('Cache-Control', 'private, no-store, max-age=0')
   next()
}

router.get('/transfers/categories', cacheable(300), listCategories)
router.get('/transfers/places', quoteLimiter, cacheable(60), listPlaces)
router.post('/transfers/quote', quoteLimiter, quoteTransfer)

// On a booked ride, by its reference (the read capability, as for the order).
router.post('/orders/:reference/transfer/rate', postLimiter, privateOnly, rateTransfer)
router.post('/orders/:reference/transfer/alert', postLimiter, privateOnly, alertTransfer)

export default router
