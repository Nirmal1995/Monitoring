import type { Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import mongoose from 'mongoose';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config/env.ts';
import { createMongoConnection } from './database/mongo.ts';
import { createLogger } from './infrastructure/logger.ts';
import { createMetricsApp } from './infrastructure/metrics-server.ts';
import { createMetrics } from './infrastructure/metrics.ts';
import { createRedis, pingRedis } from './infrastructure/redis.ts';
import { createAuthModule } from './modules/auth/index.ts';
import { ensureSessionIndexes } from './modules/auth/sessions.service.ts';
import { HealthService } from './modules/health/health.service.ts';

const VERSION = process.env.npm_package_version ?? '0.1.0';

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Logger is not configured yet; print a plain message and stop.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

function main(): void {
  const config = loadConfigOrExit();
  const logger = createLogger(config);
  const metrics = createMetrics();
  const mongo = createMongoConnection(config, logger);
  const redis = createRedis(config.REDIS_URL, logger);
  const health = new HealthService(
    [
      { name: 'mongodb', check: () => mongo.ping() },
      { name: 'redis', check: () => pingRedis(redis) },
    ],
    logger,
    metrics,
  );

  const auth = createAuthModule({
    config,
    logger,
    redis,
    // Resolves once the first MongoDB connection succeeds; the session store waits on it.
    mongoClientPromise: mongoose.connection.asPromise().then((conn) => conn.getClient()),
  });

  const app = createApp({ config, logger, health, metrics, auth, version: VERSION });

  // Start listening before the database is connected: liveness answers
  // immediately and readiness reports "not_ready" until dependencies are
  // reachable, which is how an orchestrator expects a starting instance to behave.
  const server: Server = app.listen(config.API_PORT, config.API_HOST, () => {
    logger.info(
      { host: config.API_HOST, port: config.API_PORT, version: VERSION },
      'api listening',
    );
  });
  const metricsServer = createMetricsApp(metrics).listen(
    config.API_METRICS_PORT,
    config.API_METRICS_HOST,
    () => {
      logger.info(
        { host: config.API_METRICS_HOST, port: config.API_METRICS_PORT },
        'metrics listening',
      );
    },
  );

  // Initial connection with bounded exponential backoff. After the first
  // success the driver handles reconnects itself.
  let shuttingDown = false;
  void (async () => {
    for (let attempt = 1; !shuttingDown; attempt++) {
      try {
        await mongo.connect();
        if (config.NODE_ENV !== 'production') await ensureSessionIndexes();
        return;
      } catch (err) {
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
        // The driver error itself is already logged by the connection's
        // 'error' listener; log only the retry decision here.
        logger.warn(
          { attempt, retryInMs: delay, reason: err instanceof Error ? err.name : 'unknown' },
          'mongodb not reachable, will retry',
        );
        await sleep(delay);
      }
    }
  })();

  // Graceful shutdown: stop being "ready" (load balancer drains us), stop
  // accepting connections, let in-flight requests finish, then close
  // connections. A hard deadline guarantees the process exits.
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown started');
    health.startDraining();

    const deadline = setTimeout(() => {
      logger.error('shutdown deadline exceeded, forcing exit');
      process.exit(1);
    }, config.API_SHUTDOWN_TIMEOUT_MS);
    deadline.unref();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    await mongo
      .disconnect()
      .catch((err: unknown) => logger.error({ err }, 'mongodb disconnect failed'));
    redis.disconnect();
    logger.info('shutdown complete');
    logger.flush();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection or exception leaves the process in an unknown
  // state. Log it and exit; the orchestrator starts a clean replacement.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

main();
