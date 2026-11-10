import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Request ID: unique per HTTP request, generated here unless a trusted
 * upstream (load balancer, CloudFront) supplied a well-formed one.
 * Correlation ID: shared by every request belonging to one user action, and
 * passed on to background jobs so a single action can be traced end to end.
 *
 * Incoming IDs are validated strictly: they are copied into logs and
 * response headers, so an attacker-controlled value must not be able to inject
 * new log lines or headers.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      correlationId: string;
    }
  }
}

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

function accept(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

export const requestContext: RequestHandler = (req, res, next) => {
  req.requestId = accept(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
  req.correlationId = accept(req.headers[CORRELATION_ID_HEADER]) ?? req.requestId;
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('X-Correlation-Id', req.correlationId);
  next();
};
