#!/usr/bin/env bash
# Follows infrastructure logs. Optional args: service names (mongo redis storage storage-init mailpit).
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker compose logs -f --tail=100 "$@"
