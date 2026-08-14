class AppError extends Error {
  public statusCode: number;
  public status: string;
  public isOperational: boolean;
  public message: string;
  /**
   * Machine-readable reason. Clients switch on status + this, never on the
   * human-readable message (§8) — which is also the only way a caller can tell
   * "your session is dead" from "the password you just typed is wrong". Both
   * are 401, and treating them alike logs an admin out for a single typo in a
   * re-auth dialog.
   */
  public code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super();

    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    this.message = message;
    this.code = code;

    // Set the prototype explicitly.

    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;
