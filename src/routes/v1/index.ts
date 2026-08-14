import express from 'express';
import catalogueRouter from './catalogueRouter';

const router = express.Router();

// Public catalogue, mounted at the root of /api/v1 so paths read
// /api/v1/listings, /api/v1/hotels, /api/v1/enquiries. Customer sign-in lives
// here too, as /auth/otp/request and /auth/otp/verify.
router.use('/', catalogueRouter);

export default router;
