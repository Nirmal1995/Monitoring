import { Router } from 'express';
import type { HealthService } from './health.service.ts';

export function healthRouter(health: HealthService): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    const report = await health.readiness();
    res
      .status(report.status === 'ready' ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json(report);
  });

  return router;
}
