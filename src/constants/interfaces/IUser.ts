import mongoose, { Document, Schema } from 'mongoose'

export interface IUserDocument extends Document {
  name: string;
  email: string;
  photo?: string;
  phone?: string;
  state?: string;
  city?: string;
  addressLine1?: string;
  addressLine2?: string;
  pincode?: string;
  country?: string;
  dateOfBirth?: Date;
  department?: string;
  specialization?: string;
  experience?: number;
  education?: string;
  qualifications?:[{
    degree: string;
    institution: string;
    yearOfPassing: number;
    grade?: string;
    description?: string;
  }]
  role: 'admin' | 'consultant' ;
  password: string;
  passwordConfirm?: string;
  passwordChangedAt?: Date;
  otp?: string;
  otpExpires?: Date;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  correctPassword(candidatePassword: string, userPassword: string): Promise<boolean>;
  changedPasswordAfter(JWTTimestamp: number): boolean;
  createPasswordResetOtp(): string;
}
