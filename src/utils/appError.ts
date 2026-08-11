class AppError extends Error {
  public statusCode: number;
  public status: string;
  public isOperational: boolean;
  public message: string;

  constructor(message: string, statusCode: number) {
    super();

    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    this.message = message;

    // Set the prototype explicitly.
    
    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;