# Observability

## Logs

Structured JSON via Pino, one line per event, written to stdout (the container runtime ships stdout to CloudWatch Logs in AWS).

Every request produces one line with `req.id`, `correlationId`, method, path (query string removed), status and `responseTime`. Level: `info` for 2xx/3xx, `warn` for 4xx, `error` for 5xx. Health probe requests are not logged; failed readiness checks are logged by the health service with the underlying error.

```json
{
  "level": "info",
  "time": "2026-11-10T00:12:58.325Z",
  "service": "streamhub-api",
  "env": "development",
  "req": { "id": "a508b12c-...", "method": "GET", "path": "/api/v1" },
  "correlationId": "a508b12c-...",
  "res": { "statusCode": 200 },
  "responseTime": 3,
  "msg": "GET /api/v1 200 3ms"
}
```

Never logged (redacted at serialization time even if logged by mistake): cookies, `Authorization`, CSRF tokens, `Set-Cookie`, and any field named `password`, `currentPassword`, `newPassword`, `token`, `sessionId`, `secret`, `accessKeyId`, `secretAccessKey`. MongoDB connection strings are logged with credentials replaced by `***`.

Local development: set `LOG_PRETTY=true` for colourised output (pino-pretty). Production must use JSON (`LOG_PRETTY=true` is rejected when `NODE_ENV=production`).

## Security events

Authentication events carry an `event` field for filtering (CloudWatch Logs Insights: `filter event like /^auth\./`):

| Event                                                                | Level     | Fields                                           |
| -------------------------------------------------------------------- | --------- | ------------------------------------------------ |
| `auth.register` / `auth.register.duplicate`                          | info      | `userId` or `email` fingerprint                  |
| `auth.login.succeeded`                                               | info      | `userId`                                         |
| `auth.login.failed`                                                  | warn      | `email` fingerprint (truncated SHA-256)          |
| `auth.login.blocked`                                                 | info/warn | `userId`, `reason` (`unverified`, `deactivated`) |
| `auth.logout`, `auth.session.revoked`, `auth.session.revoked_others` | info      | `userId`, `revoked`                              |
| `auth.password.rehashed`                                             | info      | `userId`                                         |
| `admin.created`, `admin.promoted`                                    | info      | `userId`, `via: cli`                             |

A spike in `auth.login.failed` across many fingerprints from few IPs suggests credential stuffing; the same fingerprint repeatedly suggests a targeted guess.

## Health checks

| Endpoint            | Meaning                         | Depends on                                                              |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `GET /health/live`  | process is running              | nothing                                                                 |
| `GET /health/ready` | instance should receive traffic | MongoDB and Redis pings (2 s timeout each); `false` while shutting down |

Liveness deliberately ignores dependencies: if it checked MongoDB, a database blip would make ECS restart every API task at once.

The API starts listening before MongoDB is connected. Until the first connection succeeds, `/health/ready` returns 503 and the API retries with exponential backoff (1 s, 2 s, 4 s ... capped at 30 s).

## Metrics

Prometheus format on a separate port: `http://127.0.0.1:4001/metrics` (`API_METRICS_HOST`/`API_METRICS_PORT`). It is not reachable through the public API port.

| Metric                                                                             | Type      | Labels                           |
| ---------------------------------------------------------------------------------- | --------- | -------------------------------- |
| `http_requests_total`                                                              | counter   | `method`, `route`, `status_code` |
| `http_request_duration_seconds`                                                    | histogram | `method`, `route`, `status_code` |
| `dependency_up`                                                                    | gauge     | `dependency`                     |
| Node.js defaults (`process_cpu_*`, `nodejs_heap_*`, `nodejs_eventloop_lag_*`, ...) | various   | none                             |

`route` is the matched route pattern (`/api/v1/videos/:id`), or `unmatched` for 404s, so label cardinality stays bounded.

Later phases add: active sessions, upload failures, processing duration and failures, catalogue latency, queue job counts.

### Useful queries (PromQL)

```promql
# error rate (5xx) over 5 minutes
sum(rate(http_requests_total{status_code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))

# p95 latency per route
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
```

## Graceful shutdown

On `SIGTERM` (sent by ECS or `docker stop`): readiness flips to 503, the HTTP server stops accepting connections and closes idle keep-alive sockets, in-flight requests finish, MongoDB disconnects, the process exits 0. If that takes longer than `API_SHUTDOWN_TIMEOUT_MS` (10 s) it exits 1. ECS removes the task from the ALB target group before sending `SIGTERM`, and the ALB deregistration delay covers in-flight requests.

## Path to AWS and Grafana

| Signal  | Local           | AWS option A (managed)                                                                         | Option B (Prometheus stack)                      |
| ------- | --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Logs    | stdout          | CloudWatch Logs (awslogs driver); Logs Insights queries on JSON fields                         | Loki + Grafana                                   |
| Metrics | `:4001/metrics` | CloudWatch agent sidecar scraping Prometheus format, or Amazon Managed Service for Prometheus  | Prometheus scraping the task, Grafana dashboards |
| Health  | `/health/*`     | ALB target group health check on `/health/ready`; ECS container health check on `/health/live` | same                                             |
| Alarms  | none            | CloudWatch Alarms on 5xx rate, p95 latency, unhealthy hosts                                    | Alertmanager                                     |

Details are designed in `docs/aws/monitoring-design.md` (Phase 10).
