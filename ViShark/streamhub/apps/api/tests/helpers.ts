import { pino, type Logger } from 'pino';
import { createApp, type AppDependencies } from '../src/app.ts';
import { createLogger } from '../src/infrastructure/logger.ts';
import { HealthService, type DependencyCheck } from '../src/modules/health/health.service.ts';

export const silentLogger = pino({ level: 'silent' });

export function buildTestApp(
  options: {
    checks?: DependencyCheck[];
    docs?: boolean;
    extraRoutes?: AppDependencies['extraRoutes'];
    logger?: Logger;
  } = {},
) {
  const health = new HealthService(options.checks ?? [], silentLogger);
  const app = createApp({
    config: {
      API_BODY_LIMIT: '1kb',
      API_TRUST_PROXY_HOPS: 0,
      API_DOCS_ENABLED: options.docs ?? true,
    },
    logger: options.logger ?? silentLogger,
    health,
    version: '0.0.0-test',
    ...(options.extraRoutes ? { extraRoutes: options.extraRoutes } : {}),
  });
  return { app, health };
}

export type LogLine = { msg?: string; level?: string; [key: string]: unknown };

/**
 * The production logger configuration (including redaction), writing parsed
 * JSON lines to an array so tests can assert on log output.
 */
export function capturingLogger() {
  const lines: LogLine[] = [];
  const logger = createLogger(
    { LOG_LEVEL: 'info', LOG_PRETTY: false, NODE_ENV: 'test' },
    { write: (chunk: string) => void lines.push(JSON.parse(chunk) as LogLine) },
  );
  return { logger, lines };
}
