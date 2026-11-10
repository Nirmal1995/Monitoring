import { Router } from 'express';
import { ok } from '../../common/http.ts';

export function metaRouter(options: { version: string; docsEnabled: boolean }): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(
      ok({
        name: 'StreamHub API',
        version: options.version,
        apiVersion: 'v1',
        docs: options.docsEnabled ? '/api/docs' : null,
      }),
    );
  });
  return router;
}
