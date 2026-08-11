import express from 'express'
import rateLimit from 'express-rate-limit'

import * as adminAuth from '../../../controllers/admin/adminAuthController'
import { protectAdmin } from '../../../middleware/adminAuth'

const router = express.Router()

/** Brute-force ceiling on top of the per-account progressive delay (§1.3). */
const loginLimiter = rateLimit({
   windowMs: 15 * 60 * 1000,
   max: 20,
   standardHeaders: true,
   legacyHeaders: false,
   message: { message: 'Too many attempts, please try again later' },
})

// --- Unauthenticated. No signup and no email-only reset by design (§1.3). ---
router.post('/login', loginLimiter, adminAuth.login)

// --- Authenticated ---
router.use(protectAdmin)

router.get('/me', adminAuth.me)
router.post('/logout', adminAuth.logout)
router.post('/step-up', adminAuth.stepUp)
router.patch('/password', adminAuth.changePassword)

router.get('/sessions', adminAuth.listSessions)
router.delete('/sessions/others', adminAuth.revokeOtherSessions)

export default router
