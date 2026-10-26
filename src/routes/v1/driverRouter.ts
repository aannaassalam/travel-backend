import express from 'express'
import rateLimit from 'express-rate-limit'
import {
   alert,
   changePassword,
   end,
   getRide,
   listRides,
   login,
   logout,
   me,
   start,
} from '../../controllers/public/driverController'
import { protectDriver } from '../../middleware/driverAuth'

const router = express.Router()

/** Like the customer's password sign-in: the one place guessing pays off. */
const loginLimiter = rateLimit({
   max: 20,
   windowMs: 60 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many sign-in attempts, please try again later' },
})

/** Like the customer's alert: each one wakes the office. */
const alertLimiter = rateLimit({
   max: 10,
   windowMs: 60 * 60 * 1000,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many requests, please try again later' },
})

// §8: never cache an authenticated response.
const privateOnly: express.RequestHandler = (_req, res, next) => {
   res.set('Cache-Control', 'private, no-store, max-age=0')
   next()
}

router.post('/driver/login', loginLimiter, login)
router.post('/driver/logout', logout)
router.get('/driver/me', privateOnly, protectDriver, me)
// It checks a password too, so it shares the sign-in budget.
router.patch('/driver/me/password', loginLimiter, protectDriver, changePassword)

router.get('/driver/rides', privateOnly, protectDriver, listRides)
router.get('/driver/rides/:reference', privateOnly, protectDriver, getRide)
router.post('/driver/rides/:reference/start', protectDriver, start)
router.post('/driver/rides/:reference/end', protectDriver, end)
router.post('/driver/rides/:reference/alert', alertLimiter, protectDriver, alert)

export default router
