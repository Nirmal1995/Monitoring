import { createHash, randomBytes } from 'node:crypto';
import MongoStore from 'connect-mongo';
import type { RequestHandler } from 'express';
import session from 'express-session';
import type { MongoClient } from 'mongodb';
import type { AppConfig } from '../../config/env.ts';
import { sessionExpired } from '../../middleware/authenticate.ts';

/**
 * Server-side sessions stored in MongoDB.
 *
 * - The browser only holds an opaque, random session ID (192 bits) in an
 *   HttpOnly cookie. JavaScript cannot read it, so XSS cannot steal it.
 * - The database stores SHA-256(session ID), not the ID itself, so a leaked
 *   database dump or backup does not allow hijacking sessions.
 * - Each session also gets a public "handle" (a second random value) used to
 *   list and revoke sessions; real session IDs are never sent to clients.
 */
declare module 'express-session' {
  interface SessionData {
    userId: string;
    handle: string;
    csrfToken: string;
    createdAt: number;
    lastSeenAt: number;
    userAgent: string | null;
    ip: string | null;
  }
}

export const SESSIONS_COLLECTION = 'sessions';

export type SessionPolicy = {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  /** How often lastSeenAt is persisted; bounds database writes per active session. */
  touchIntervalMs: number;
};

export function sessionPolicyFromConfig(
  config: Pick<AppConfig, 'SESSION_IDLE_TIMEOUT_MINUTES' | 'SESSION_ABSOLUTE_TIMEOUT_HOURS'>,
): SessionPolicy {
  const idleTimeoutMs = config.SESSION_IDLE_TIMEOUT_MINUTES * 60_000;
  return {
    idleTimeoutMs,
    absoluteTimeoutMs: config.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000,
    touchIntervalMs: Math.min(60_000, Math.floor(idleTimeoutMs / 4)),
  };
}

export function cookieName(secure: boolean): string {
  // The __Host- prefix makes the browser refuse the cookie unless it is Secure,
  // has Path=/ and no Domain: it cannot be set or overwritten by a subdomain.
  return secure ? '__Host-streamhub.sid' : 'streamhub.sid';
}

export const hashSessionId = (sid: string) => createHash('sha256').update(sid).digest('hex');
export const randomToken = (bytes: number) => randomBytes(bytes).toString('base64url');

export function createSessionMiddleware(options: {
  config: Pick<AppConfig, 'SESSION_SECRET' | 'COOKIE_SECURE'>;
  policy: SessionPolicy;
  clientPromise: Promise<MongoClient>;
}): RequestHandler {
  const { config, policy } = options;
  const store = MongoStore.create({
    clientPromise: options.clientPromise,
    collectionName: SESSIONS_COLLECTION,
    stringify: false,
    autoRemove: 'native',
    touchAfter: Math.max(1, Math.floor(policy.touchIntervalMs / 1000)),
    transformId: hashSessionId,
  });

  return session({
    name: cookieName(config.COOKIE_SECURE),
    secret: config.SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    unset: 'destroy',
    cookie: {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      maxAge: policy.idleTimeoutMs,
    },
  });
}

/**
 * Enforces idle and absolute timeouts on the server (the cookie lifetime is
 * only a hint to the browser and can be tampered with). Also records
 * lastSeenAt, but at most once per touch interval to limit writes.
 */
export function sessionTimeouts(policy: SessionPolicy): RequestHandler {
  return (req, _res, next) => {
    const data = req.session;
    if (!data?.userId) {
      next();
      return;
    }
    const now = Date.now();
    // Missing timestamps mean a malformed session: treat it as expired.
    const lastSeenAt = data.lastSeenAt ?? 0;
    const idleExpired = now - lastSeenAt > policy.idleTimeoutMs;
    const absoluteExpired = now - (data.createdAt ?? 0) > policy.absoluteTimeoutMs;
    if (idleExpired || absoluteExpired) {
      req.session.destroy(() => next(sessionExpired()));
      return;
    }
    if (now - lastSeenAt >= policy.touchIntervalMs) data.lastSeenAt = now;
    next();
  };
}
