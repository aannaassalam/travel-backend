import * as Joi from 'joi';
import { Request, Response, NextFunction } from 'express';
import AppError from './appError';

// User signup validation schema - name, email, password, passwordConfirm are required
const userSignupSchema = Joi.object({
    name: Joi.string().min(2).max(50).trim().required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8),
    passwordConfirm: Joi.string().valid(Joi.ref('password')).messages({
        'any.only': 'Passwords must match'
    }),
    photo: Joi.string().uri().allow(''),
    phone: Joi.string().pattern(/^[0-9+\-\s()]+$/).min(10).max(15),
    state: Joi.string().max(50).trim(),
    city: Joi.string().max(50).trim(),
    addressLine1: Joi.string().max(100).trim(),
    addressLine2: Joi.string().max(100).trim(),
    pincode: Joi.string().pattern(/^[0-9]{4,10}$/),
    country: Joi.string().max(50).trim(),
    dateOfBirth: Joi.date().max('now'),
    department: Joi.string().max(50).trim(),
    specialization: Joi.string().max(100).trim(),
    experience: Joi.number().integer().min(0).max(50),
    education: Joi.string().max(200).trim(),
    qualifications: Joi.array().items(
        Joi.object({
            degree: Joi.string().max(100).trim().required(),
            institution: Joi.string().max(100).trim().required(),
            yearOfPassing: Joi.number().integer().min(1950).max(new Date().getFullYear()),
            grade: Joi.string().max(10).trim(),
            description: Joi.string().max(500).trim()
        })
    ),
    // role: Joi.string().valid('admin', 'consultant').default('consultant')
}).unknown(false).messages({
    'object.unknown': 'Invalid input - field "{#label}" is not allowed'
});

// User update validation schema - only allow specific fields
// Only allow safe fields to be updated: name, photo, active
// Exclude sensitive fields like email, password, role, otp, etc.
const userUpdateSchema = Joi.object({
    name: Joi.string().min(2).max(50).trim(),
    photo: Joi.string().uri().allow(''),
    phone: Joi.string().pattern(/^[0-9+\-\s()]+$/).min(10).max(15),
    state: Joi.string().max(50).trim(),
    city: Joi.string().max(50).trim(),
    addressLine1: Joi.string().max(100).trim(),
    addressLine2: Joi.string().max(100).trim(),
    pincode: Joi.string(),
    country: Joi.string().max(50).trim(),
    dateOfBirth: Joi.date().max('now'),
    department: Joi.string().max(50).trim(),
    specialization: Joi.string().max(100).trim(),
    experience: Joi.number().integer().min(0).max(50),
    education: Joi.string().max(200).trim(),
    active: Joi.boolean(),
    qualifications: Joi.array().items(
        Joi.object({
            degree: Joi.string().max(100).trim(),
            institution: Joi.string().max(100).trim(),
            yearOfPassing: Joi.number().integer().min(1950).max(new Date().getFullYear()),
            grade: Joi.string().max(10).trim(),
            description: Joi.string().max(500).trim()
        })
    ),
   
}).unknown(false).messages({
    'object.unknown': 'Invalid input - field "{#label}" is not allowed'
});

// Generic validation middleware factory
const validatePayload = (schema: Joi.ObjectSchema) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const { error } = schema.validate(req.body, { 
            abortEarly: false, // Show all validation errors
            stripUnknown: false // Don't strip unknown fields, throw error instead
        });

        if (error) {
            const errorMessage = error.details.map(detail => detail.message).join(', ');
            return next(new AppError('Invalid input', 400));
        }

        next();
    };
};

// Specific middleware for user signup
export const validateUserSignup = validatePayload(userSignupSchema);

// Specific middleware for user updates
export const validateUserUpdate = validatePayload(userUpdateSchema);

// Export the factory function for potential future use
export { validatePayload };
