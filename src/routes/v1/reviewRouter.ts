import express from 'express'
import rateLimit from 'express-rate-limit'
import {
   createReview,
   listReviews,
   myReview,
} from '../../controllers/public/reviewController'
import { protectCustomer } from '../../middleware/customerAuth'

const router = express.Router()

/** Limited like lead capture: every review is read by someone in the office. */
const reviewLimiter = rateLimit({
   max: 10,
   windowMs: 60 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many reviews, please try again later' },
})

/**
 * Approved reviews hold nothing customer-specific, so a short public cache is
 * fine: a review the office has just approved shows within the minute.
 */
const briefly: express.RequestHandler = (_req, res, next) => {
   res.set('Cache-Control', 'public, max-age=30, s-maxage=60')
   next()
}

// §8: never cache an authenticated response.
const privateOnly: express.RequestHandler = (_req, res, next) => {
   res.set('Cache-Control', 'private, no-store, max-age=0')
   next()
}

router.get('/reviews', briefly, listReviews)
router.post('/reviews', reviewLimiter, protectCustomer, createReview)
router.get('/me/reviews', privateOnly, protectCustomer, myReview)

export default router
