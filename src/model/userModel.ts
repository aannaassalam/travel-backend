import mongoose, { Schema } from 'mongoose';
import validator from 'validator';
import bcrypt from 'bcryptjs';

import { IUserDocument } from '../constants/interfaces/IUser';
import AppError from '../utils/appError';


const userSchema = new Schema<IUserDocument>({
    name: {
        type: String,
        required: [true, 'Please tell us your name!'],
    },
    email: {
        type: String,
        required: [true, 'Please provide your email'],
        unique: true,
        lowercase: true,
        validate: [validator.isEmail, 'please provide a valid email'],
    },
    photo: String,
    phone:{
        type: String,
        validate: {
            validator: function (v: string) {
                return /^\+?[1-9]\d{1,14}$/.test(v); // E.164 format
            },
            message: 'Please provide a valid phone number',
        },
        required: false, // Optional field
        minlength: 10, // Minimum length for phone number
        maxlength: 15, // Maximum length for phone number
    },
    state: String,
    city: String,
    addressLine1: String,
    addressLine2: String,
    pincode: String,
    country: String,
    dateOfBirth: Date,
    department: String,
    specialization: String,
    experience: {
        type: Number,
        min: 0,
        default: 0,
    },
    education: String,
    qualifications: [{
        degree: String,
        institution: String,
        yearOfPassing: Number,
        grade: String,
        description: String,
    }],
    role: {
        type: String,
        enum: ['admin', 'consultant'],
        default: 'consultant',
    },
    password: {
        type: String,
        required: [true, 'please provide a password'],
        minlength: 8,
        select: false,
    },
    passwordConfirm: {
        type: String,
        required: [true, 'Please confirm your password'],
        validate: {
            validator: function (this: IUserDocument, el: string) {
                return el === this.password;
            },
            message: 'Passwords are not the Same!',
        },
    },
    passwordChangedAt: Date,
    otp: String,
    otpExpires: Date,
 
    active: {
        type: Boolean,
        default: true,
        // select: false,
    },
},{
    timestamps: true,
});

userSchema.pre<IUserDocument>('save', async function (next) {
    if (!this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, 12);
    this.passwordConfirm = undefined;
    next();
});

userSchema.pre<IUserDocument>('save', function (next) {
    if (!this.isModified('password') || this.isNew) return next();
    this.passwordChangedAt = new Date(Date.now() - 1000);
    next();
});

// userSchema.pre(/^find/, function (this: mongoose.Query<IUserDocument, IUserDocument>, next) {
//     this.find({ active: { $ne: false } });
//     next();
// });


userSchema.methods.correctPassword = async function (
    candidatePassword: string,
    userPassword: string
) {
    //check user is active or not
    if (!this.active) {
        throw new AppError('Your account is deactivated. Please contact support.', 403);
    }
    return await bcrypt.compare(candidatePassword, userPassword);
};

userSchema.methods.changedPasswordAfter = function (JWTTimestamp: number) {
    if (this.passwordChangedAt) {
        const changedTimestamp = Math.floor(this.passwordChangedAt.getTime() / 1000);
        return JWTTimestamp < changedTimestamp;
    }
    return false;
};

userSchema.methods.createPasswordResetOtp = function () {
    const resetOtp = Math.floor(100000 + Math.random() * 900000).toString();
    this.otp = resetOtp;
    this.otpExpires = new Date(Date.now() + 10 * 60 * 1000);
    return resetOtp;
};

const UserModel = mongoose.model<IUserDocument>('User', userSchema);
export default UserModel;

