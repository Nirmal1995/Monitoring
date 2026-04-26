#!/usr/bin/env bash
# ==============================================================================
# Monitoring Lab Setup Script
# ------------------------------------------------------------------------------
# Creates a complete local monitoring stack with:
#   - Prometheus       (metrics collection)        http://localhost:9090
#   - Grafana          (dashboards)                http://localhost:3000
#   - Node Exporter    (host metrics)              http://localhost:9100
#   - cAdvisor         (container metrics)         http://localhost:8080
#   - Alertmanager     (alert routing)             http://localhost:9093
#   - Sample app       (Python Flask + metrics)    http://localhost:5000
#
# Usage:
#   chmod +x setup-monitoring-lab.sh
#   ./setup-monitoring-lab.sh
#
# Then: cd monitoring-lab && docker compose up -d
# ==============================================================================

set -euo pipefail

PROJECT_DIR="monitoring-lab"

# ---- Colors for output -------------------------------------------------------
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }

# ---- Pre-flight checks -------------------------------------------------------
log "Checking prerequisites..."

if ! command -v docker &>/dev/null; then
  warn "Docker not found. Install Docker Desktop first: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker compose version &>/dev/null; then
  warn "Docker Compose v2 not found. Update Docker Desktop or install the compose plugin."
  exit 1
fi

ok "Docker and Docker Compose are available."

# ---- Project structure -------------------------------------------------------
log "Creating project structure at ./${PROJECT_DIR}"

if [ -d "${PROJECT_DIR}" ]; then
  warn "Directory '${PROJECT_DIR}' already exists. Files will be overwritten."
  read -p "Continue? (y/N) " -n 1 -r; echo
  [[ ! $REPLY =~ ^[Yy]$ ]] && { log "Aborted."; exit 0; }
fi

mkdir -p "${PROJECT_DIR}"/{prometheus/rules,grafana/provisioning/datasources,grafana/provisioning/dashboards,grafana/dashboards,alertmanager,sample-app}

cd "${PROJECT_DIR}"

# ---- docker-compose.yml ------------------------------------------------------
log "Writing docker-compose.yml..."

cat > docker-compose.yml <<'EOF'
services:
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    restart: unless-stopped
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./prometheus/rules:/etc/prometheus/rules:ro
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=15d'
      - '--web.enable-lifecycle'
    networks:
      - monitoring

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
      - ./grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana-data:/var/lib/grafana
    networks:
      - monitoring
    depends_on:
      - prometheus

  node-exporter:
    image: prom/node-exporter:latest
    container_name: node-exporter
    restart: unless-stopped
    ports:
      - "9100:9100"
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
      - '--path.rootfs=/rootfs'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    networks:
      - monitoring

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    container_name: cadvisor
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker:/var/lib/docker:ro
      - /dev/disk:/dev/disk:ro
    privileged: true
    devices:
      - /dev/kmsg
    networks:
      - monitoring

  alertmanager:
    image: prom/alertmanager:latest
    container_name: alertmanager
    restart: unless-stopped
    ports:
      - "9093:9093"
    volumes:
      - ./alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
    command:
      - '--config.file=/etc/alertmanager/alertmanager.yml'
    networks:
      - monitoring

  sample-app:
    build: ./sample-app
    container_name: sample-app
    restart: unless-stopped
    ports:
      - "5000:5000"
    networks:
      - monitoring

networks:
  monitoring:
    driver: bridge

volumes:
  prometheus-data:
  grafana-data:
EOF

ok "docker-compose.yml created."

# ---- Prometheus config -------------------------------------------------------
log "Writing Prometheus config..."

cat > prometheus/prometheus.yml <<'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

rule_files:
  - '/etc/prometheus/rules/*.yml'

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']

  - job_name: 'sample-app'
    static_configs:
      - targets: ['sample-app:5000']
EOF

# ---- Sample alert rules ------------------------------------------------------
cat > prometheus/rules/alerts.yml <<'EOF'
groups:
  - name: host_alerts
    rules:
      - alert: HighCPUUsage
        expr: 100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 80
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "High CPU on {{ $labels.instance }}"
          description: "CPU usage is above 80% for more than 2 minutes."

      - alert: HighMemoryUsage
        expr: (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100 > 85
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "High memory on {{ $labels.instance }}"
          description: "Memory usage is above 85%."

      - alert: TargetDown
        expr: up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Target {{ $labels.instance }} is down"
          description: "Prometheus cannot scrape {{ $labels.job }}."
EOF

ok "Prometheus configuration created."

# ---- Alertmanager config -----------------------------------------------------
log "Writing Alertmanager config..."

cat > alertmanager/alertmanager.yml <<'EOF'
route:
  group_by: ['alertname']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 1h
  receiver: 'default'

receivers:
  - name: 'default'
    # For real notifications, configure email/slack/webhook here.
    # Local lab: alerts just appear in the Alertmanager UI.

inhibit_rules:
  - source_match:
      severity: 'critical'
    target_match:
      severity: 'warning'
    equal: ['alertname', 'instance']
EOF

ok "Alertmanager configuration created."

# ---- Grafana datasource provisioning -----------------------------------------
log "Writing Grafana provisioning..."

cat > grafana/provisioning/datasources/prometheus.yml <<'EOF'
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: true
EOF

# ---- Grafana dashboard provisioning ------------------------------------------
cat > grafana/provisioning/dashboards/dashboards.yml <<'EOF'
apiVersion: 1
providers:
  - name: 'default'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    editable: true
    updateIntervalSeconds: 10
    options:
      path: /var/lib/grafana/dashboards
EOF

# ---- Starter Grafana dashboard (Node Exporter quick view) --------------------
cat > grafana/dashboards/host-overview.json <<'EOF'
{
  "annotations": {"list": []},
  "editable": true,
  "panels": [
    {
      "type": "stat",
      "title": "CPU Usage %",
      "gridPos": {"h": 6, "w": 6, "x": 0, "y": 0},
      "targets": [
        {
          "expr": "100 - (avg by(instance) (rate(node_cpu_seconds_total{mode=\"idle\"}[5m])) * 100)",
          "refId": "A"
        }
      ],
      "datasource": {"type": "prometheus", "uid": "prometheus"},
      "fieldConfig": {"defaults": {"unit": "percent", "max": 100, "min": 0}}
    },
    {
      "type": "stat",
      "title": "Memory Used %",
      "gridPos": {"h": 6, "w": 6, "x": 6, "y": 0},
      "targets": [
        {
          "expr": "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100",
          "refId": "A"
        }
      ],
      "datasource": {"type": "prometheus", "uid": "prometheus"},
      "fieldConfig": {"defaults": {"unit": "percent", "max": 100, "min": 0}}
    },
    {
      "type": "timeseries",
      "title": "CPU Usage Over Time",
      "gridPos": {"h": 8, "w": 12, "x": 0, "y": 6},
      "targets": [
        {
          "expr": "100 - (avg by(instance, mode) (rate(node_cpu_seconds_total{mode!=\"idle\"}[5m])) * 100)",
          "legendFormat": "{{mode}}",
          "refId": "A"
        }
      ],
      "datasource": {"type": "prometheus", "uid": "prometheus"}
    },
    {
      "type": "timeseries",
      "title": "Network I/O",
      "gridPos": {"h": 8, "w": 12, "x": 12, "y": 6},
      "targets": [
        {
          "expr": "rate(node_network_receive_bytes_total{device!=\"lo\"}[5m])",
          "legendFormat": "RX {{device}}",
          "refId": "A"
        },
        {
          "expr": "rate(node_network_transmit_bytes_total{device!=\"lo\"}[5m])",
          "legendFormat": "TX {{device}}",
          "refId": "B"
        }
      ],
      "datasource": {"type": "prometheus", "uid": "prometheus"},
      "fieldConfig": {"defaults": {"unit": "Bps"}}
    }
  ],
  "refresh": "10s",
  "schemaVersion": 38,
  "tags": ["lab", "host"],
  "time": {"from": "now-30m", "to": "now"},
  "title": "Host Overview",
  "uid": "host-overview",
  "version": 1
}
EOF

ok "Grafana dashboards provisioned."

# ---- Sample Flask app exposing /metrics --------------------------------------
log "Writing sample app..."

cat > sample-app/app.py <<'EOF'
"""
Tiny Flask app that exposes Prometheus metrics on /metrics.
Endpoints:
    /         -> hello, increments request counter
    /slow     -> 1-2s latency, good for histogram practice
    /error    -> randomly returns 500 ~30% of the time
    /metrics  -> Prometheus scrape endpoint
"""
import random
import time
from flask import Flask, Response
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

app = Flask(__name__)

REQUEST_COUNT = Counter(
    'app_requests_total', 'Total HTTP requests',
    ['method', 'endpoint', 'status']
)
REQUEST_LATENCY = Histogram(
    'app_request_duration_seconds', 'Request latency',
    ['endpoint']
)

@app.route('/')
def home():
    with REQUEST_LATENCY.labels(endpoint='/').time():
        REQUEST_COUNT.labels('GET', '/', '200').inc()
        return 'Hello from the sample app! Try /slow and /error too.\n'

@app.route('/slow')
def slow():
    with REQUEST_LATENCY.labels(endpoint='/slow').time():
        time.sleep(random.uniform(1, 2))
        REQUEST_COUNT.labels('GET', '/slow', '200').inc()
        return 'That was slow.\n'

@app.route('/error')
def error():
    with REQUEST_LATENCY.labels(endpoint='/error').time():
        if random.random() < 0.3:
            REQUEST_COUNT.labels('GET', '/error', '500').inc()
            return 'Something broke', 500
        REQUEST_COUNT.labels('GET', '/error', '200').inc()
        return 'OK this time.\n'

@app.route('/metrics')
def metrics():
    return Response(generate_latest(), mimetype=CONTENT_TYPE_LATEST)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
EOF

cat > sample-app/requirements.txt <<'EOF'
flask==3.0.0
prometheus-client==0.19.0
EOF

cat > sample-app/Dockerfile <<'EOF'
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
EXPOSE 5000
CMD ["python", "app.py"]
EOF

ok "Sample app created."

# ---- README ------------------------------------------------------------------
log "Writing README..."

cat > README.md <<'EOF'
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
EOF

ok "README created."

# ---- Done --------------------------------------------------------------------
echo
ok "Setup complete!"
echo
echo "Next steps:"
echo "  1.  cd ${PROJECT_DIR}"
echo "  2.  docker compose up -d"
echo "  3.  Open http://localhost:3000 (Grafana, admin/admin)"
echo "  4.  Open http://localhost:9090 (Prometheus)"
echo
echo "See README.md for PromQL practice queries and traffic-generation tips."
