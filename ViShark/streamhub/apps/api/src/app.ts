import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import swaggerUi from 'swagger-ui-express';
import type { AppConfig } from './config/env.ts';
import type { Metrics } from './infrastructure/metrics.ts';
import type { AuthModule } from './modules/auth/index.ts';
import { errorHandler, notFoundHandler } from './middleware/error-handler.ts';
import { createHttpLogger } from './middleware/http-logger.ts';
import { requestContext } from './middleware/request-context.ts';
import type { HealthService } from './modules/health/health.service.ts';
import { healthRouter } from './modules/health/health.routes.ts';
import { metaRouter } from './modules/meta/meta.routes.ts';
import { buildOpenApiDocument } from './openapi/document.ts';

export type AppDependencies = {
  config: Pick<AppConfig, 'API_BODY_LIMIT' | 'API_TRUST_PROXY_HOPS' | 'API_DOCS_ENABLED'>;
  logger: Logger;
  health: HealthService;
  metrics?: Metrics;
  /** Sessions, CSRF, auth and user routes. Omitted in tests that only exercise the foundation. */
  auth?: AuthModule;
  version: string;
  /** Test hook: extra routes mounted before the 404 handler. */
  extraRoutes?: (app: Express) => void;
};

/**
 * Builds the Express application without starting a server, so tests can
 * exercise the full middleware chain in-process with Supertest.
 *
 * Middleware order matters:
 *   1. request IDs (everything after can log them)
 *   2. request logging and metrics
 *   3. security headers
 *   4. health probes (before body parsing; they never need a body)
 *   5. body parsing with a size limit
 *   6. versioned API routes (database guard, session, CSRF, user, then features)
 *   7. 404, then the error handler (always last)
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  const { config } = deps;

  app.disable('x-powered-by');
  app.set('trust proxy', config.API_TRUST_PROXY_HOPS);
  // Reject ambiguous query strings like ?a[b]=1 being parsed into objects.
  app.set('query parser', 'simple');

  app.use(requestContext);
  app.use(createHttpLogger(deps.logger));
  if (deps.metrics) app.use(deps.metrics.middleware);

  // The API only ever returns JSON, so the strictest CSP is fine here.
  // Swagger UI gets its own policy below.
  const apiHelmet = helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });

  app.use('/health', apiHelmet, healthRouter(deps.health));

  if (config.API_DOCS_ENABLED) {
    const document = buildOpenApiDocument(deps.version);
    const docsHelmet: RequestHandler = helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          frameAncestors: ["'none'"],
        },
      },
    });
    app.get('/api/v1/openapi.json', apiHelmet, (_req, res) => {
      res.json(document);
    });
    app.use(
      '/api/docs',
      docsHelmet,
      swaggerUi.serve,
      swaggerUi.setup(document, { customSiteTitle: 'StreamHub API' }),
    );
  }

  app.use(apiHelmet);
  app.use(express.json({ limit: config.API_BODY_LIMIT }));

  const v1 = express.Router();
  // API info stays available without a database or session.
  v1.use('/', metaRouter({ version: deps.version, docsEnabled: config.API_DOCS_ENABLED }));
  if (deps.auth) {
    v1.use(...deps.auth.pipeline);
    for (const { path, router } of deps.auth.routes) v1.use(path, router);
  }
  app.use('/api/v1', v1);

  deps.extraRoutes?.(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
