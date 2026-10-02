import { Request, Response, NextFunction } from 'express';
import AppError from '../../utils/appError';

const handleCastErrorDb = (err: any) => {
  const message = `Invalid ${err.path}: ${err.value}.`;
  return new AppError(message, 400);
};

const handleDuplicateFieldsDB = (err: any) => {
  // errmsg does not always quote the value; a missing match must not throw inside the error handler.
  const value = err.errmsg?.match(/(["'])(?:(?=(\\?))\2.)*?\1/)?.[0] ?? 'That value';
  const message = `${value} already used. Please use another value!`;
  return new AppError(message, 400);
};

const handleValidationErrorDb = (err: any) => {
  const error = Object.values(err.errors).map((el: any) => el.message);
  const message = `Invalid Input data. ${error.join('. ')}`;
  return new AppError(message, 400);
};

// §BUG-030: an invalid token is unauthenticated (401), not "not found" (404).
const handleJWTError = () => new AppError('Invalid token. Please log in again!', 401);
const handleJWTExpiredError = () => new AppError('Your token has expired! Please log in again', 401);

// §BUG-006: dev keeps stack and details to debug with, but never echoes the raw
// error object (`error: err`) — a raw Mongo/driver error carries cluster hosts,
// namespaces and codes. Only AppError's own curated fields are returned.
const sentErrorDev = (err: AppError, res: Response) => {
  res.status(err.statusCode).json({
    status: err.status,
    code: err.code,
    message: err.message,
    // Whatever the upstream actually said — see AppError.details.
    details: err.details,
    stack: err.stack
  });
};

const sentErrorProd = (err: AppError, res: Response) => {
  if (err.isOperational) {
    /**
     * Note what is absent: `details` and `stack`. A provider's refusal names
     * endpoints, merchant state and sometimes the reason an account is
     * restricted — useful to us, a free reconnaissance report to anyone else.
     * It is logged instead, where only the office can read it.
     */
    res.status(err.statusCode).json({
      status: err.status,
      code: err.code,
      message: err.message
    });
  } else {
    /**
     * §BUG-006: anything that is not an operational AppError — a raw Mongo
     * driver error (e.g. the regex Location51091), a programming fault — is
     * collapsed to a generic 500. The real error is logged server-side; the
     * client never sees a driver object, a stack or cluster internals.
     */
    console.error('Error', err);
    res.status(500).json({
      status: 'error',
      code: 'INTERNAL',
      message: 'Something went wrong'
    });
  }
};


const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  // Two writers changed the same document at once and the second was refused.
  // That is a retry, not a server fault — in every environment.
  if (err.name === 'VersionError') {
    err = new AppError('This was changed by someone else at the same moment. Try again.', 409, 'CONFLICT');
  }
  // Known library errors map to their real status in EVERY environment. Mapping
  // only on the prod branch meant a Mongoose ValidationError was a 400 in prod
  // but a 500 in dev, so local runs never exercised the client's 400 handling.
  let error: any = err;
  if (err.name === 'CastError') error = handleCastErrorDb(err);
  if (err.code === 11000) error = handleDuplicateFieldsDB(err);
  if (err.name === 'ValidationError') error = handleValidationErrorDb(err);
  if (err.name === 'JsonWebTokenError') error = handleJWTError();
  if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();
  error.statusCode = error.statusCode || 500;
  error.status = error.status || 'error';

  // Anything that is not explicitly development is treated as production.
  // Previously an unset or non-standard NODE_ENV (staging, test) matched
  // neither branch, so no response was ever sent and the request hung until
  // the client timed out.
  // §BUG-006: NODE_ENV MUST be 'production' in deployed environments — only the
  // dev branch returns stack/details, and leaking them in prod is the bug.
  if (process.env.NODE_ENV === 'development') {
    sentErrorDev(error, res);
  } else {
    sentErrorProd(error, res);
  }
  next();
};

export default errorHandler;