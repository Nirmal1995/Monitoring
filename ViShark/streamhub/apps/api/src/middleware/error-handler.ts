import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../common/errors.ts';
import type { ErrorBody } from '../common/http.ts';

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ErrorBody = {
    error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.requestId },
  };
  res.status(404).json(body);
};

type BodyParserError = Error & { type?: string; status?: number };

/**
 * Last middleware in the chain. Converts any error into the standard error
 * envelope. Stack traces, driver messages and other internals are logged but
 * never sent to the client: unexpected errors become a generic 500.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';
  let details: unknown;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof Error && (err as BodyParserError).type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large';
  } else if (err instanceof Error && (err as BodyParserError).type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Request body is not valid JSON';
  } else if (err instanceof Error && (err as BodyParserError).type === 'charset.unsupported') {
    status = 415;
    code = 'UNSUPPORTED_MEDIA_TYPE';
    message = 'Unsupported charset';
  }

  if (status >= 500) {
    req.log.error({ err }, 'unhandled error');
  } else {
    req.log.warn({ code, status }, message);
  }

  const body: ErrorBody = { error: { code, message, requestId: req.requestId } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
};
