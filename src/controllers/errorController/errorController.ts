import { Request, Response, NextFunction } from 'express';
import AppError from '../../utils/appError';

const handleCastErrorDb = (err: any) => {
  const message = `Invalid ${err.path}: ${err.value}.`;
  return new AppError(message, 400);
};

const handleDuplicateFieldsDB = (err: any) => {
  const value = err.errmsg.match(/(["'])(?:(?=(\\?))\2.)*?\1/)[0];
  const message = `${value} already used. Please use another value!`;
  return new AppError(message, 400);
};

const handleValidationErrorDb = (err: any) => {
  const error = Object.values(err.errors).map((el: any) => el.message);
  const message = `Invalid Input data. ${error.join('. ')}`;
  return new AppError(message, 400);
};

const handleJWTError = () => new AppError('Invalid token. Please log in again!', 404);
const handleJWTExpiredError = () => new AppError('Your token has expired! Please log in again', 401);

const sentErrorDev = (err: AppError, res: Response) => {
  res.status(err.statusCode).json({
    status: err.status,
    error: err,
    code: err.code,
    message: err.message,
    stack: err.stack
  });
};

const sentErrorProd = (err: AppError, res: Response) => { 
  if (err.isOperational) {
    res.status(err.statusCode).json({
      status: err.status,
      code: err.code,
      message: err.message
    });
  } else {
    console.error('Error �', err);
    res.status(500).json({
      status: 'error',
      message: 'Something went very wrong!'
    });
  }
};


const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  // Anything that is not explicitly development is treated as production.
  // Previously an unset or non-standard NODE_ENV (staging, test) matched
  // neither branch, so no response was ever sent and the request hung until
  // the client timed out.
  if (process.env.NODE_ENV === 'development') {
    sentErrorDev(err, res);
  } else {
    let error = { ...err };
    if (err.name === 'CastError') error = handleCastErrorDb(err);
    if (err.code === 11000) error = handleDuplicateFieldsDB(err);
    if (err.name === 'ValidationError') error = handleValidationErrorDb(err);
    if (err.name === 'JsonWebTokenError') error = handleJWTError();
    if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();
    sentErrorProd(error, res);
  }
  next();
};

export default errorHandler;