import express from 'express';
import catalogueRouter from './catalogueRouter';
import driverRouter from './driverRouter';
import reviewRouter from './reviewRouter';
import transferRouter from './transferRouter';

const router = express.Router();

// Public catalogue, mounted at the root of /api/v1 so paths read
// /api/v1/listings, /api/v1/hotels, /api/v1/enquiries. Customer sign-in lives
// here too, as /auth/otp/request and /auth/otp/verify.
router.use('/', catalogueRouter);
// Customer reviews: /api/v1/reviews, and the signed-in /api/v1/me/reviews.
router.use('/', reviewRouter);
// Transfers: /api/v1/transfers/*, the rating and the alert on a booked ride,
// and the driver portal's /api/v1/driver/*.
router.use('/', transferRouter);
router.use('/', driverRouter);

export default router;
