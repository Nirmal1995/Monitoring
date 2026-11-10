#!/usr/bin/env bash
# DESTRUCTIVE: removes all StreamHub containers AND their data volumes
# (database, queues, stored videos, captured emails). Asks for confirmation.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
require_cmd docker
wait_for_docker

warn "This permanently deletes ALL local StreamHub data:"
docker volume ls --filter label=com.docker.compose.project=streamhub --format '  - {{.Name}}'
echo
read -r -p "Type 'reset streamhub' to continue: " answer
[ "$answer" = "reset streamhub" ] || die "aborted, nothing was deleted"

docker compose down --volumes --remove-orphans
ok "all StreamHub containers and volumes removed. Start fresh with: pnpm infra:up"
