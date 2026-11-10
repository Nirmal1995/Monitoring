import { isIPv6 } from 'node:net';
import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { AppError } from '../common/errors.ts';

/**
 * Fixed-window rate limiter backed by Redis, so limits hold across every API
 * instance (an in-memory limiter would give each ECS task its own budget).
 *
 * If Redis is unavailable the limiter fails CLOSED with 503: for login
 * endpoints, silently disabling brute-force protection during an outage is
 * worse than temporarily refusing logins.
 */
export const serviceUnavailable = () =>
  new AppError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable, please retry shortly');

export const tooManyRequests = (message = 'Too many requests, please try again later') =>
  new AppError(429, 'TOO_MANY_REQUESTS', message);

/**
 * Groups IPv6 clients by /64 network. A single IPv6 subscriber usually controls
 * a whole /64 (2^64 addresses), so limiting per full address is trivial to evade.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const value = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!isIPv6(value)) return value;
  const [head = '', tail = ''] = value.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const full = [...headParts, ...Array<string>(Math.max(missing, 0)).fill('0'), ...tailParts];
  return `${full
    .slice(0, 4)
    .map((part) => part.padStart(4, '0'))
    .join(':')}::/64`;
}

export type FixedWindow = { count: number; ttlSeconds: number };

/** Atomically increments a counter and starts its expiry window on first use. */
export async function hit(redis: Redis, key: string, windowSeconds: number): Promise<FixedWindow> {
  try {
    const results = await redis.multi().incr(key).expire(key, windowSeconds, 'NX').ttl(key).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
    return { count, ttlSeconds: ttl > 0 ? ttl : windowSeconds };
  } catch {
    throw serviceUnavailable();
  }
}

export function rateLimit(options: {
  redis: Redis;
  name: string;
  limit: number;
  windowSeconds: number;
  key?: (req: Request) => string;
}): RequestHandler {
  const keyOf = options.key ?? ((req: Request) => clientKey(req.ip));
  return async (req, res, next) => {
    try {
      const { count, ttlSeconds } = await hit(
        options.redis,
        `rl:${options.name}:${keyOf(req)}`,
        options.windowSeconds,
      );
      const remaining = Math.max(options.limit - count, 0);
      res.setHeader('RateLimit-Policy', `${options.limit};w=${options.windowSeconds}`);
      res.setHeader(
        'RateLimit',
        `limit=${options.limit}, remaining=${remaining}, reset=${ttlSeconds}`,
      );
      if (count > options.limit) {
        res.setHeader('Retry-After', String(ttlSeconds));
        throw tooManyRequests();
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
