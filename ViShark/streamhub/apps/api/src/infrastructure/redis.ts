import { Redis } from 'ioredis';
import type { Logger } from 'pino';

/**
 * Redis client for rate limiting (and, from Phase 6, job queues).
 *
 * enableOfflineQueue=false and maxRetriesPerRequest=1: if Redis is down,
 * commands fail immediately instead of queueing in memory and hanging the
 * request. Callers turn that failure into a 503.
 */
export function createRedis(url: string, logger: Logger): Redis {
  const log = logger.child({ component: 'redis' });
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });
  redis.on('ready', () => log.info('connected'));
  redis.on('end', () => log.warn('connection closed'));
  // ioredis emits 'error' on every failed reconnect attempt; log at warn and
  // let readiness report the outage.
  redis.on('error', (err: Error) =>
    log.warn({ err: { message: err.message } }, 'connection error'),
  );
  return redis;
}

export async function pingRedis(redis: Redis): Promise<void> {
  const reply = await redis.ping();
  if (reply !== 'PONG') throw new Error('unexpected PING reply');
}
