import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { hit, serviceUnavailable, tooManyRequests } from '../../middleware/rate-limit.ts';

/**
 * Counts failed logins per email address in Redis, whether or not an account
 * with that email exists. Throttling only real accounts would let an attacker
 * discover which emails are registered by watching who gets throttled.
 *
 * This is throttling, not a permanent lockout: the window expires on its own,
 * so an attacker cannot lock a victim out indefinitely.
 */
export type LoginThrottle = {
  assertAllowed: (email: string) => Promise<void>;
  recordFailure: (email: string) => Promise<void>;
  reset: (email: string) => Promise<void>;
};

export function createLoginThrottle(
  redis: Redis,
  limit: number,
  windowSeconds: number,
): LoginThrottle {
  const keyOf = (email: string) => `login-fail:${createHash('sha256').update(email).digest('hex')}`;
  return {
    async assertAllowed(email) {
      let count: string | null;
      try {
        count = await redis.get(keyOf(email));
      } catch {
        throw serviceUnavailable();
      }
      if (Number(count ?? 0) >= limit) {
        throw tooManyRequests('Too many failed attempts for this account, please try again later');
      }
    },
    async recordFailure(email) {
      await hit(redis, keyOf(email), windowSeconds);
    },
    async reset(email) {
      await redis.del(keyOf(email)).catch(() => undefined);
    },
  };
}
