import express from 'express';
import * as authController from '../../controllers/authController';
import { validateUserSignup } from '../../utils/validator';


const router = express.Router();

router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.post('/forgotPassword', authController.forgotPassword);
router.post('/verifyOtp', authController.verifyOtp);
router.post('/resetPassword', authController.resetPassword);

// Protect all routes after this middleware
router.use(authController.protect);

router.patch('/updatePassword', authController.updatePassword);

// Example of role-based restriction:
// router.get('/adminOnly', authController.restrictTo('admin'), (req, res) => res.send('Admin only!'));

export default router;
