import mongoose, { Schema } from 'mongoose';
import validator from 'validator';
import bcrypt from 'bcryptjs';
import { ICustomerModel } from '../constants/interfaces/ICustomerModel';

const customerSchema = new Schema<ICustomerModel>({
    email: {
        type: String,
        required: [true, 'Please provide your email'],
        unique: true,
        lowercase: true,
        validate: [validator.isEmail, 'please provide a valid email'],
    },
    photo: String,
    name: {
        type: String,
        required: [true, 'Please tell us your name!'],
    },
    phone: String,
    countryCode: String,
    addressLine1: String,
    addressLine2: String,
    street: String,
    city: String,
    state: String,
    postalCode: String,
    country: String,
    consultantType:{
        type: String,
        enum: ['internal', 'external'],
        required: [true, 'Please specify the consultant type'],
    },
    internalConsultant: {
        type: Schema.Types.ObjectId,
        ref: 'User',
    },
    externalConsultant: {
        name: String,
        email: String,
        phone: String,
    },
    subscriptionStatus: {
        type: String,
        enum: ['active', 'inactive', 'cancelled', 'expired'],
        default: 'inactive',
    },
    subscriptionStartDate: Date,
    subscriptionEndDate: Date,
    comments: {
        type: String,
        trim: true,
        maxlength: [500, 'Comments cannot exceed 500 characters'],
    },
},
{
    timestamps: true,
});

customerSchema.pre<ICustomerModel>('save', async function (next) {
    if (!this.isModified('email')) return next();
    this.email = this.email.toLowerCase();
    next();
});

const Customer = mongoose.model<ICustomerModel>('Customer', customerSchema);
export default Customer;