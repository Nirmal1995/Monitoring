import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

/**
 * One structured log line per request with method, path, status, duration,
 * request and correlation IDs. Query strings are dropped from the logged URL
 * because they can carry tokens (for example in email links).
 */
/**
 * Full path without the query string. Uses originalUrl because Express
 * rewrites req.url inside mounted routers ("/api/docs/x.css" becomes "/x.css").
 */
function pathOf(req: IncomingMessage): string {
  const url = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
  return url.split('?')[0] ?? '';
}

export function createHttpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req) => (req as unknown as Request).requestId,
    customProps: (req) => ({ correlationId: (req as unknown as Request).correlationId }),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Health probes run every few seconds and would drown out real traffic.
    // Failing dependency checks are logged by the health module instead.
    autoLogging: { ignore: (req) => pathOf(req).startsWith('/health/') },
    serializers: {
      req: (req: IncomingMessage & { id?: string; raw?: IncomingMessage }) => ({
        id: req.id,
        method: req.method,
        path: pathOf(req.raw ?? req),
        userAgent: req.headers['user-agent'],
      }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
    },
    customSuccessMessage: (req, res, responseTime) =>
      `${req.method} ${pathOf(req)} ${res.statusCode} ${Math.round(responseTime)}ms`,
    customErrorMessage: (req, res) => `${req.method} ${pathOf(req)} ${res.statusCode}`,
  });
}
