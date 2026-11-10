import { can, type Permission } from '@streamhub/shared';
import type { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../common/errors.ts';
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
    }
  }
}

/**
 * Loads the current user from the database on every authenticated request.
 * Role and status are therefore always current: deactivating an account or
 * removing an admin role takes effect on the user's very next request, not
 * when their session happens to expire.
 */
export const loadUser: RequestHandler = async (req, _res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
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

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : unauthorized());
};

/**
 * Server-side authorization. Hiding a button in the UI is a usability
 * feature; this check is the security control.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    next(
      can(req.user.role, permission)
        ? undefined
        : forbidden('You do not have permission to do this'),
    );
  };
}
