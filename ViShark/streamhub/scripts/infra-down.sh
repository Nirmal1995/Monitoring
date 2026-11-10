#!/usr/bin/env bash
# Stops local infrastructure. Data in named volumes is kept.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
require_cmd docker
wait_for_docker
docker compose down
ok "infrastructure stopped (data volumes kept; use pnpm infra:reset to wipe them)"
