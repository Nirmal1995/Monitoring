import type { RequestHandler, Response, Router } from 'express';
import type { Redis } from 'ioredis';
import type { MongoClient } from 'mongodb';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env.ts';
import type { Mailer } from '../../infrastructure/mailer.ts';
import { loadUser } from '../../middleware/authenticate.ts';
import { csrfProtection } from '../../middleware/csrf.ts';
import { requireDatabase } from '../../middleware/require-database.ts';
import { usersRouter } from '../users/users.routes.ts';
import { authRouter } from './auth.routes.ts';
import { createAuthService } from './auth.service.ts';
import { createLoginThrottle } from './login-throttle.ts';
import { createPasswordHasher } from './password.ts';
import {
  cookieName,
  createSessionMiddleware,
  sessionPolicyFromConfig,
  sessionTimeouts,
  type SessionPolicy,
} from './session.ts';
import {
  EmailVerificationTokenModel,
  PasswordResetTokenModel,
  createTokenStore,
} from './tokens.ts';

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
  | 'AUTH_EMAIL_LIMIT_PER_HOUR'
  | 'EMAIL_VERIFICATION_TTL_HOURS'
  | 'PASSWORD_RESET_TTL_MINUTES'
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
  mailer: Mailer;
  mongoClientPromise: Promise<MongoClient>;
  /** Tests override timeouts to seconds instead of minutes. */
  policy?: SessionPolicy;
}): AuthModule {
  const { config } = deps;
  const policy = deps.policy ?? sessionPolicyFromConfig(config);
  const sessionCookie = cookieName(config.COOKIE_SECURE);
  const auth = createAuthService({
    hasher: createPasswordHasher(config),
    throttle: createLoginThrottle(
      deps.redis,
      config.AUTH_ACCOUNT_FAILURE_LIMIT,
      config.AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS,
    ),
    logger: deps.logger,
    mailer: deps.mailer,
    redis: deps.redis,
    verificationTokens: createTokenStore(
      EmailVerificationTokenModel,
      config.EMAIL_VERIFICATION_TTL_HOURS * 3_600_000,
    ),
    resetTokens: createTokenStore(
      PasswordResetTokenModel,
      config.PASSWORD_RESET_TTL_MINUTES * 60_000,
    ),
    settings: {
      requireEmailVerification: config.AUTH_REQUIRE_EMAIL_VERIFICATION,
      webOrigin: config.WEB_ORIGIN,
      emailLimitPerHour: config.AUTH_EMAIL_LIMIT_PER_HOUR,
      verificationTtlHours: config.EMAIL_VERIFICATION_TTL_HOURS,
      resetTtlMinutes: config.PASSWORD_RESET_TTL_MINUTES,
    },
  });
  const clearSessionCookie = (res: Response) =>
    res.clearCookie(sessionCookie, {
      path: '/',
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax',
    });

  return {
    pipeline: [
      requireDatabase,
      createSessionMiddleware({ config, policy, clientPromise: deps.mongoClientPromise }),
      sessionTimeouts(policy),
      csrfProtection([config.WEB_ORIGIN, ...config.CSRF_EXTRA_TRUSTED_ORIGINS]),
      loadUser(sessionCookie),
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
      { path: '/users', router: usersRouter({ auth, clearSessionCookie }) },
    ],
  };
}
