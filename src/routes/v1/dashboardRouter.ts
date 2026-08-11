import express from 'express';
import { adminDashboard, consultantDashboard } from '../../controllers/customController';
import { protect, restrictTo } from '../../controllers/authController';

const router = express.Router();

router.use(protect); // Protect all routes in this router
router.get('/admin', restrictTo('admin'), adminDashboard);

router.get('/consutant', restrictTo('consultant'), consultantDashboard);



export default router;