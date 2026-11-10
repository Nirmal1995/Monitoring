import { can, type Permission } from '@streamhub/shared';
import type { RequestHandler } from 'express';
import { AppError, forbidden, unauthorized } from '../common/errors.ts';
import { UserModel, type UserDocument } from '../modules/users/user.model.ts';

export type AuthenticatedUser = Pick<
  UserDocument,
  '_id' | 'email' | 'displayName' | 'role' | 'status' | 'emailVerifiedAt' | 'createdAt'
>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      /** The browser sent a session cookie, but no valid session exists for it. */
      staleSession?: boolean;
    }
  }
}

export const sessionExpired = () =>
  new AppError(401, 'SESSION_EXPIRED', 'Your session has expired, please sign in again');

/**
 * Loads the current user from the database on every authenticated request.
 * Role and status are therefore always current: deactivating an account or
 * removing an admin role takes effect on the user's very next request, not
 * when their session happens to expire.
 */
export function loadUser(sessionCookieName: string): RequestHandler {
  const cookiePrefix = `${sessionCookieName}=`;
  return async (req, _res, next) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        // A cookie that no longer maps to a session: expired, revoked or
        // logged out elsewhere. Lets the client say "session expired"
        // instead of a generic "please sign in".
        req.staleSession = (req.headers.cookie ?? '')
          .split(/;\s*/)
          .some((c) => c.startsWith(cookiePrefix));
        next();
        return;
      }
      const user = await UserModel.findById(userId)
        .select('email displayName role status emailVerifiedAt createdAt')
        .lean<AuthenticatedUser>();
      if (!user || user.status !== 'ACTIVE') {
        req.session.destroy(() => next());
        return;
      }
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (req.user) next();
  else next(req.staleSession ? sessionExpired() : unauthorized());
};

/**
 * Server-side authorization. Hiding a button in the UI is a usability
 * feature; this check is the security control.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(req.staleSession ? sessionExpired() : unauthorized());
      return;
    }
    next(
      can(req.user.role, permission)
        ? undefined
        : forbidden('You do not have permission to do this'),
    );
  };
}
