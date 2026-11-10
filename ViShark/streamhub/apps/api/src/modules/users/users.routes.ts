import {
  deactivateAccountBodySchema,
  updateProfileBodySchema,
  type DeactivateAccountBody,
  type UpdateProfileBody,
} from '@streamhub/contracts';
import { Router, type Response } from 'express';
import { notFound } from '../../common/errors.ts';
import { ok } from '../../common/http.ts';
import { requireAuth, requirePermission } from '../../middleware/authenticate.ts';
import { validate } from '../../middleware/validate.ts';
import type { AuthService } from '../auth/auth.service.ts';
import { toUserDto } from './user.dto.ts';
import { UserModel } from './user.model.ts';

/**
 * /users/me only ever addresses the signed-in user, identified by the session.
 * There is no user ID in the URL, so there is nothing to tamper with (IDOR).
 */
export function usersRouter(deps: {
  auth: AuthService;
  clearSessionCookie: (res: Response) => void;
}): Router {
  const router = Router();

  router.get('/me', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store').json(ok(toUserDto(req.user!)));
  });

  router.patch(
    '/me',
    requireAuth,
    requirePermission('profile:manage-own'),
    validate({ body: updateProfileBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: UpdateProfileBody };
      // Explicit field list: even if validation were bypassed, only displayName can change.
      const updated = await UserModel.findByIdAndUpdate(
        req.user!._id,
        { $set: { displayName: body.displayName } },
        { returnDocument: 'after', runValidators: true },
      ).exec();
      if (!updated) throw notFound();
      res.json(ok(toUserDto(updated)));
    },
  );

  router.post(
    '/me/deactivate',
    requireAuth,
    requirePermission('profile:manage-own'),
    validate({ body: deactivateAccountBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: DeactivateAccountBody };
      await deps.auth.deactivate(req.user!._id.toString(), body.password);
      deps.clearSessionCookie(res);
      res.status(204).end();
    },
  );

  return router;
}
