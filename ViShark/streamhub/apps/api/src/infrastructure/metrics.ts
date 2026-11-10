import type { RequestHandler } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. Served on a separate, internal-only port so they are
 * never exposed through the public load balancer.
 *
 * Label values come from the matched route pattern ("/api/v1/videos/:id"),
 * never the raw URL; raw URLs contain IDs and would create one time series per
 * video, an unbounded "cardinality explosion".
 */
export type Metrics = ReturnType<typeof createMetrics>;

export function createMetrics() {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'streamhub-api' });
  collectDefaultMetrics({ register: registry });

  const httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by route and status',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });

  const dependencyUp = new Gauge({
    name: 'dependency_up',
    help: '1 if the dependency passed its last readiness check, else 0',
    labelNames: ['dependency'] as const,
    registers: [registry],
  });

  const middleware: RequestHandler = (req, res, next) => {
    const stop = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route
        ? `${req.baseUrl}${String((req.route as { path: unknown }).path)}`.replace(/(.)\/$/, '$1')
        : 'unmatched';
      const labels = { method: req.method, route, status_code: String(res.statusCode) };
      httpRequestDuration.observe(labels, Number(process.hrtime.bigint() - stop) / 1e9);
      httpRequestsTotal.inc(labels);
    });
    next();
  };

  return { registry, middleware, dependencyUp };
}
