#!/usr/bin/env bash
# Starts local infrastructure and waits until every service is healthy.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
require_cmd docker
load_env
wait_for_docker

info "starting MongoDB, Redis, storage, Mailpit"
# --wait blocks until healthchecks pass (and storage-init exits successfully).
if ! docker compose up -d --wait --wait-timeout 240; then
  fail "one or more services did not become healthy"
  docker compose ps -a
  info "inspect with: pnpm infra:logs <service>"
  exit 1
fi

docker compose ps
ok "infrastructure is up"
cat <<EOM

  MongoDB        127.0.0.1:${MONGO_PORT:-27017}
  Redis          127.0.0.1:${REDIS_PORT:-6379}
  Storage API    http://127.0.0.1:${STORAGE_API_PORT:-9000}
  Storage UI     http://127.0.0.1:${STORAGE_CONSOLE_PORT:-9001}  (STORAGE_ROOT_USER / STORAGE_ROOT_PASSWORD in .env)
  Mailpit UI     http://127.0.0.1:${MAILPIT_UI_PORT:-8025}

  Next: pnpm infra:verify
EOM
