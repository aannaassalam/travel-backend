import express from 'express';
import authRouter from './authRouter';
import catalogueRouter from './catalogueRouter';
import userRouter from './userRouter';
import dashboardRouter from './dashboardRouter';


const router = express.Router();

// Public catalogue, mounted at the root of /api/v1 so paths read
// /api/v1/listings, /api/v1/hotels, /api/v1/enquiries.
router.use('/', catalogueRouter);

router.use('/auth', authRouter);
router.use('/user', userRouter);
router.use('/dashboard', dashboardRouter);

// Azure Blob uploads unmounted — not used by this project. Importing the router
// pulled in utils/azure.ts, which opened a storage client at module load and
// crashed the whole server at boot when the Azure vars were unset.
// Storage for §5 galleries and §6.5 travel documents is still an open choice.
// import uploadFileRouter from './uploadFileRouter';
// router.use('/uploads', uploadFileRouter);

export default router;
