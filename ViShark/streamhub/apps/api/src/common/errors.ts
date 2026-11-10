/**
 * Errors the application raises on purpose. Anything else reaching the error
 * handler is treated as an unexpected 500 and its details are never exposed.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = 'Bad request', details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'Forbidden') => new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message = 'Conflict') => new AppError(409, 'CONFLICT', message);
