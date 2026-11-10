import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../common/errors.ts';

/**
 * Cross-Site Request Forgery protection for cookie-authenticated requests,
 * in two layers:
 *
 * 1. Origin verification on every state-changing request. Browsers attach
 *    Origin (and Sec-Fetch-Site) to cross-site POSTs and scripts cannot forge
 *    them. Requests without either header are not from a browser, so they
 *    cannot be a CSRF attack (CSRF needs a victim's browser and its cookies).
 *    This layer also protects login and registration, which have no session.
 * 2. Synchronizer token for authenticated sessions: a random value stored in
 *    the session, given to the app at login, and required in X-CSRF-Token.
 *    A cross-site page cannot read it (same-origin policy), so it cannot send it.
 *
 * SameSite=Lax on the session cookie is a third, browser-side layer.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const csrfFailed = (message: string) => new AppError(403, 'CSRF_FAILED', message);

function tokensMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function csrfProtection(trustedOrigins: readonly string[]): RequestHandler {
  const trusted = new Set(trustedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    if (origin !== undefined) {
      if (!trusted.has(origin)) {
        next(csrfFailed('Request origin is not allowed'));
        return;
      }
    } else if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      next(csrfFailed('Cross-site request blocked'));
      return;
    }

    const expected = req.session?.csrfToken;
    if (req.session?.userId && expected) {
      const received = req.get('x-csrf-token');
      if (!received || !tokensMatch(expected, received)) {
        next(csrfFailed('Missing or invalid CSRF token'));
        return;
      }
    }
    next();
  };
}
