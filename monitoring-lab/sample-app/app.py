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
