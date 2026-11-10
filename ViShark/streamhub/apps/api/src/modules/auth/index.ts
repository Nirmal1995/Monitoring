import type { RequestHandler, Router } from 'express';
import type { Redis } from 'ioredis';
import type { MongoClient } from 'mongodb';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env.ts';
import { loadUser } from '../../middleware/authenticate.ts';
import { csrfProtection } from '../../middleware/csrf.ts';
import { requireDatabase } from '../../middleware/require-database.ts';
import { usersRouter } from '../users/users.routes.ts';
import { authRouter } from './auth.routes.ts';
import { createAuthService } from './auth.service.ts';
import { createLoginThrottle } from './login-throttle.ts';
import { createPasswordHasher } from './password.ts';
import {
  createSessionMiddleware,
  sessionPolicyFromConfig,
  sessionTimeouts,
  type SessionPolicy,
} from './session.ts';

export type AuthModuleConfig = Pick<
  AppConfig,
  | 'SESSION_SECRET'
  | 'COOKIE_SECURE'
  | 'SESSION_IDLE_TIMEOUT_MINUTES'
  | 'SESSION_ABSOLUTE_TIMEOUT_HOURS'
  | 'WEB_ORIGIN'
  | 'CSRF_EXTRA_TRUSTED_ORIGINS'
  | 'ARGON2_MEMORY_KIB'
  | 'ARGON2_TIME_COST'
  | 'ARGON2_PARALLELISM'
  | 'AUTH_REQUIRE_EMAIL_VERIFICATION'
  | 'AUTH_IP_LIMIT'
  | 'AUTH_IP_WINDOW_SECONDS'
  | 'AUTH_ACCOUNT_FAILURE_LIMIT'
  | 'AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS'
>;

export type AuthModule = {
  /** Runs before feature routes: database guard, session, timeouts, CSRF, current user. */
  pipeline: RequestHandler[];
  /** Feature routers to mount under /api/v1. */
  routes: { path: string; router: Router }[];
};

export function createAuthModule(deps: {
  config: AuthModuleConfig;
  logger: Logger;
  redis: Redis;
  mongoClientPromise: Promise<MongoClient>;
  /** Tests override timeouts to seconds instead of minutes. */
  policy?: SessionPolicy;
}): AuthModule {
  const { config } = deps;
  const policy = deps.policy ?? sessionPolicyFromConfig(config);
  const auth = createAuthService({
    hasher: createPasswordHasher(config),
    throttle: createLoginThrottle(
      deps.redis,
      config.AUTH_ACCOUNT_FAILURE_LIMIT,
      config.AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS,
    ),
    logger: deps.logger,
    requireEmailVerification: config.AUTH_REQUIRE_EMAIL_VERIFICATION,
  });

  return {
    pipeline: [
      requireDatabase,
      createSessionMiddleware({ config, policy, clientPromise: deps.mongoClientPromise }),
      sessionTimeouts(policy),
      csrfProtection([config.WEB_ORIGIN, ...config.CSRF_EXTRA_TRUSTED_ORIGINS]),
      loadUser,
    ],
    routes: [
      {
        path: '/auth',
        router: authRouter({
          auth,
          redis: deps.redis,
          cookieSecure: config.COOKIE_SECURE,
          limits: { ipLimit: config.AUTH_IP_LIMIT, ipWindowSeconds: config.AUTH_IP_WINDOW_SECONDS },
        }),
      },
      { path: '/users', router: usersRouter() },
    ],
  };
}
