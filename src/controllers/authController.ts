import crypto from 'crypto';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';
import UserModel from '../model/userModel';
import catchAsync from '../utils/catchAsync';
import AppError from '../utils/appError';
import { sendResponse } from '../utils/response';
import { sendEmail, azureSendMail } from '../utils/email_sms';
import { PASSWORD_HTML, OTP_RESET_HTML, WELCOME_EMAIL_HTML } from '../constants/constants';
import { presentPublicUser } from '../dto/public/user.dto';
// import sendEmail from '../utils/email_sms'; // Uncomment and implement as needed

const signToken = (id: string) => {
    return jwt.sign({ id }, process.env.JWT_SECRET as string, {
        expiresIn: process.env.JWT_EXPIRES_IN,
    });
};

const createSendToken = (user: any, statusCode: number, res: Response) => {
    const token = signToken(user._id);
    const cookieOptions: any = {
        expires: new Date(
            Date.now() + (Number(process.env.JWT_COOKIE_EXPIRES_IN) || 7) * 24 * 60 * 60 * 1000
        ),
        httpOnly: true,
    };
    if (process.env.NODE_ENV === 'production') cookieOptions.secure = true;
    res.cookie('jwt', token, cookieOptions);
    // §14.3: never return the ORM entity. Spreading the user document leaked
    // `otp` and `otpExpires` — the very values that authorise a password reset.
    sendResponse(res, statusCode, 'Success', { token, user: presentPublicUser(user) });
};

export const signup = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { 
        name, 
        email, 
        password, 
        passwordConfirm, 
        photo, 
        phone, 
        state, 
        city, 
        addressLine1, 
        addressLine2, 
        pincode, 
        country, 
        dateOfBirth, 
        department, 
        specialization, 
        experience,
        education,
        qualifications
    } = req.body;

    // `role` is deliberately NOT destructured from req.body. It used to be, and
    // was passed straight to UserModel.create — so an unauthenticated POST with
    // {"role":"admin"} minted an admin account and every restrictTo('admin')
    // check then passed. Privilege is assigned server-side or not at all.

    // Role ranking for hierarchy
    
    let finalPassword = password;
    let finalPasswordConfirm = passwordConfirm;

    // If password is not provided, generate and email it
    if (!finalPassword) {
        finalPassword = crypto.randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
        finalPasswordConfirm = finalPassword;
        try {
            await sendEmail({
                email,
                subject: 'Your System Generated Password',
                html: PASSWORD_HTML(name, finalPassword),
            });
        } catch (err) {
            return next(new AppError('Failed to send generated password email', StatusCodes.INTERNAL_SERVER_ERROR));
        }
    }

    const newUser = await UserModel.create({
        name,
        email,
        password: finalPassword,
        passwordConfirm: finalPasswordConfirm,
        photo,
        phone,
        state,
        city,
        addressLine1,
        addressLine2,
        pincode,
        country,
        dateOfBirth,
        department,
        specialization,
        experience,
        education,
        qualifications
        // role omitted — the schema default applies.
    });

    // Send welcome email
    try {
        await sendEmail({
            email,
            subject: 'Welcome to Health Consultant!',
            html: WELCOME_EMAIL_HTML(name, newUser.role),
        });
    } catch (err) {
        console.warn('Failed to send welcome email:', err);
    }

    createSendToken(newUser, StatusCodes.CREATED, res);
});

export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return next(new AppError('Please provide email and password!', StatusCodes.BAD_REQUEST));
    }
    const user = await UserModel.findOne({ email }).select('+password');
    user.updatedAt= new Date(); // Update the last updated time
    await user.save({ validateBeforeSave: false });
    if (!user || !(await user.correctPassword(password, user.password))) {
        return next(new AppError('Incorrect email or password', StatusCodes.UNAUTHORIZED));
    }
    createSendToken(user, StatusCodes.OK, res);
});

export const protect = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
        return next(new AppError('You are not logged in! Please log in to get access.', StatusCodes.UNAUTHORIZED));
    }
    const decoded: any = await promisify(jwt.verify)(token, process.env.JWT_SECRET as string);
    const currentUser = await UserModel.findById(decoded.id);
    if (!currentUser) {
        return next(new AppError('The user belonging to this token does no longer exist.', StatusCodes.UNAUTHORIZED));
    }
    if (currentUser.changedPasswordAfter(decoded.iat)) {
        return next(new AppError('User recently changed password! Please log in again.', StatusCodes.UNAUTHORIZED));
    }
    req.user = currentUser;
    next();
});

export const restrictTo = (...roles: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!roles.includes(req.user.role)) {
            return next(new AppError('You do not have permission to perform this action', StatusCodes.FORBIDDEN));
        }
        next();
    };
};

export const forgotPassword = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (!user) {
        return next(new AppError('There is no user with email address', StatusCodes.NOT_FOUND));
    }
    const resetOtp = user.createPasswordResetOtp();
    await user.save({ validateBeforeSave: false });

    try {
        await sendEmail({
            email: user.email,
            subject: 'Your password reset OTP (valid for 10 min)',
            html: OTP_RESET_HTML(user.name, resetOtp),
        });
        sendResponse(res, StatusCodes.OK, 'OTP sent to email!');
    } catch (err) {
        user.otp = undefined;
        user.otpExpires = undefined;
        await user.save({ validateBeforeSave: false });
        return next(new AppError('There was an error sending the email. Try again later!', StatusCodes.INTERNAL_SERVER_ERROR));
    }
});
export const verifyOtp = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { otp, email } = req.body;
    const user = await UserModel.findOne({
        otp: otp,
        email: email,
        otpExpires: { $gt: Date.now() },
    });
    if (!user) {
        return next(new AppError('OTP is invalid or has expired', StatusCodes.BAD_REQUEST));
    }

    user.otp = undefined; // Clear OTP after verification
    user.otpExpires = undefined; // Clear OTP expiration
    await user.save({ validateBeforeSave: false });
    // If OTP is valid, send success response
    sendResponse(res, StatusCodes.OK, 'OTP is valid', { userId: user._id });
});

export const resetPassword = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const {  email,password , passwordConfirm} = req.body;
    const user = await UserModel.findOne({
        email: email,
         
    });
    if (!user) {
        return next(new AppError('OTP is invalid or has expired', StatusCodes.BAD_REQUEST));
    }
    user.password = password;
    user.passwordConfirm = passwordConfirm;
    await user.save();
    createSendToken(user, StatusCodes.OK, res);
});

export const updatePassword = catchAsync(async (req: any, res: Response, next: NextFunction) => {
    const user = await UserModel.findById(req.user.id).select('+password');
    if (!user || !(await user.correctPassword(req.body.passwordCurrent, user.password))) {
        return next(new AppError('Your current password is wrong', StatusCodes.UNAUTHORIZED));
    }
    user.password = req.body.password;
    user.passwordConfirm = req.body.passwordConfirm;
    user.passwordChangedAt = new Date();
    await user.save();
    createSendToken(user, StatusCodes.OK, res);
});
