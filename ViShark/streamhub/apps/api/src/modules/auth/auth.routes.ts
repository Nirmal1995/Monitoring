import {
  loginBodySchema,
  registerBodySchema,
  sessionHandleParamsSchema,
  type LoginBody,
  type RegisterBody,
} from '@streamhub/contracts';
import { Router, type Request, type Response } from 'express';
import type { Redis } from 'ioredis';
import { notFound } from '../../common/errors.ts';
import { ok } from '../../common/http.ts';
import { requireAuth, requirePermission } from '../../middleware/authenticate.ts';
import { rateLimit } from '../../middleware/rate-limit.ts';
import { validate } from '../../middleware/validate.ts';
import { toUserDto } from '../users/user.dto.ts';
import type { AuthService } from './auth.service.ts';
import { cookieName, randomToken } from './session.ts';
import { listSessions, revokeOtherSessions, revokeSession } from './sessions.service.ts';

const regenerate = (req: Request) =>
  new Promise<void>((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err as Error) : resolve())),
  );
const save = (req: Request) =>
  new Promise<void>((resolve, reject) =>
    req.session.save((err) => (err ? reject(err as Error) : resolve())),
  );
const destroy = (req: Request) =>
  new Promise<void>((resolve, reject) =>
    req.session.destroy((err) => (err ? reject(err as Error) : resolve())),
  );

export function authRouter(deps: {
  auth: AuthService;
  redis: Redis;
  cookieSecure: boolean;
  limits: { ipLimit: number; ipWindowSeconds: number };
}): Router {
  const router = Router();
  const ipLimiter = (name: string) =>
    rateLimit({
      redis: deps.redis,
      name,
      limit: deps.limits.ipLimit,
      windowSeconds: deps.limits.ipWindowSeconds,
    });
  const clearSessionCookie = (res: Response) =>
    res.clearCookie(cookieName(deps.cookieSecure), {
      path: '/',
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: 'lax',
    });

  router.get('/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) {
      res.json(ok({ authenticated: false }));
      return;
    }
    res.json(
      ok({
        authenticated: true,
        user: toUserDto(req.user),
        csrfToken: req.session.csrfToken,
      }),
    );
  });

  router.post(
    '/register',
    ipLimiter('register'),
    validate({ body: registerBodySchema }),
    async (_req, res) => {
      const { body } = res.locals.validated as { body: RegisterBody };
      await deps.auth.register(body);
      res.status(202).json(
        ok({
          message:
            'If this email can be registered, you will receive a verification email shortly.',
        }),
      );
    },
  );

  router.post(
    '/login',
    ipLimiter('login'),
    validate({ body: loginBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: LoginBody };
      const user = await deps.auth.login(body);

      // Session fixation defence: whatever session ID the browser had before
      // login is discarded, and the authenticated session gets a fresh ID.
      await regenerate(req);
      const now = Date.now();
      req.session.userId = user._id.toString();
      req.session.handle = randomToken(16);
      req.session.csrfToken = randomToken(32);
      req.session.createdAt = now;
      req.session.lastSeenAt = now;
      req.session.userAgent = req.get('user-agent')?.slice(0, 256) ?? null;
      req.session.ip = req.ip ?? null;
      await save(req);

      res.set('Cache-Control', 'no-store');
      res.json(ok({ user: toUserDto(user), csrfToken: req.session.csrfToken }));
    },
  );

  router.post('/logout', async (req, res) => {
    const userId = req.session?.userId;
    if (userId) {
      await destroy(req);
      req.log.info({ event: 'auth.logout', userId }, 'logged out');
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get(
    '/sessions',
    requireAuth,
    requirePermission('sessions:manage-own'),
    async (req, res) => {
      const sessions = await listSessions(req.session.userId ?? '', req.session.handle);
      res.set('Cache-Control', 'no-store').json(ok(sessions));
    },
  );

  router.delete(
    '/sessions/:handle',
    requireAuth,
    requirePermission('sessions:manage-own'),
    validate({ params: sessionHandleParamsSchema }),
    async (req, res) => {
      const { params } = res.locals.validated as { params: { handle: string } };
      const removed = await revokeSession(req.session.userId ?? '', params.handle);
      // Same 404 whether the handle does not exist or belongs to someone else.
      if (!removed) throw notFound('Session not found');
      req.log.info(
        { event: 'auth.session.revoked', userId: req.session.userId },
        'session revoked',
      );
      if (params.handle === req.session.handle) clearSessionCookie(res);
      res.status(204).end();
    },
  );

  router.delete(
    '/sessions',
    requireAuth,
    requirePermission('sessions:manage-own'),
    async (req, res) => {
      const revoked = await revokeOtherSessions(req.session.userId ?? '', req.session.handle);
      req.log.info(
        { event: 'auth.session.revoked_others', userId: req.session.userId, revoked },
        'other sessions revoked',
      );
      res.json(ok({ revoked }));
    },
  );

  return router;
}
