import express from 'express';
import * as factory from './../../controllers/handleFactory';
import { protect } from '../../controllers/authController';
import { validateUserUpdate } from '../../utils/validator';
import Customer from '../../model/customerModel';
import UserModel from '../../model/userModel';
import { sendRenewSubscriptionAlert } from '../../controllers/customController';

const router = express.Router();
router.use(protect);

//customer routes
router.route('/customer').post(factory.createOne(Customer)).get(factory.getAll(Customer));
router.route('/customer/:id')
    // getOne populates from ?populate=, not from an options argument — the
    // { path } object was never read and broke the build's type check.
    .get(factory.getOne(Customer))
    .patch(factory.updateOne(Customer))
    .delete(factory.deleteOne(Customer));
router.post('/sendRenewSubscriptionAlert',sendRenewSubscriptionAlert);

//user routes
router.route('/user').get(factory.getAll(UserModel))
router.route('/user/:id')
    .get(factory.getOne(UserModel)) 
    .patch(validateUserUpdate, factory.updateOne(UserModel))
    .delete(factory.deleteOne(UserModel));

export default router;
