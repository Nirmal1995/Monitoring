# Monitoring Lab

Local Prometheus + Grafana stack for learning observability.

## Quick start

```bash
docker compose up -d
```

Wait ~30 seconds for everything to start, then open:

| Service       | URL                   | Login         |
|---------------|-----------------------|---------------|
| Grafana       | http://localhost:3000 | admin / admin |
| Prometheus    | http://localhost:9090 | -             |
| Alertmanager  | http://localhost:9093 | -             |
| cAdvisor      | http://localhost:8080 | -             |
| Sample app    | http://localhost:5000 | -             |
| Node Exporter | http://localhost:9100 | -             |

## Generate some traffic

```bash
# Hit the sample app a bunch of times to populate metrics
while true; do
  curl -s http://localhost:5000/ > /dev/null
  curl -s http://localhost:5000/slow > /dev/null
  curl -s http://localhost:5000/error > /dev/null
  sleep 1
done
```

## PromQL practice queries

Try these in the Prometheus UI (http://localhost:9090) or in Grafana's Explore:

1.  `up`
    -- Which targets are reachable? (1 = yes, 0 = no)
2.  `rate(app_requests_total[5m])`
    -- Request rate per second over the last 5 min
3.  `sum by (status) (rate(app_requests_total[5m]))`
    -- Same but grouped by HTTP status code
4.  `histogram_quantile(0.95, rate(app_request_duration_seconds_bucket[5m]))`
    -- 95th percentile latency
5.  `100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`
    -- CPU usage %
6.  `(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100`
    -- Memory used %
7.  `rate(container_cpu_usage_seconds_total{name!=""}[5m])`
    -- Per-container CPU
8.  `sum(rate(app_requests_total{status="500"}[5m])) / sum(rate(app_requests_total[5m]))`
    -- Error ratio
9.  `predict_linear(node_filesystem_avail_bytes[1h], 4*3600) < 0`
    -- Will disk fill in the next 4 hours?
10. `increase(app_requests_total[1h])`
    -- Total requests in the last hour

## Stop the stack

```bash
docker compose down           # stop containers
docker compose down -v        # stop + delete volumes (fresh start)
```
