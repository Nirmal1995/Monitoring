import express from 'express';
import type { Metrics } from './metrics.ts';

/** Minimal app exposing /metrics on the internal metrics port. */
export function createMetricsApp(metrics: Metrics) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });
  return app;
}
