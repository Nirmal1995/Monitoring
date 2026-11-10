#!/usr/bin/env bash
# Shared helpers for StreamHub scripts. Source this file; do not execute it.
#
# Every script that sources this file also writes its full output to
# .logs/<script-name>.log so results can be reviewed after the fact.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SCRIPT_NAME="$(basename "${0%.sh}")"
LOG_DIR="$REPO_ROOT/.logs"
LOG_FILE="$LOG_DIR/$SCRIPT_NAME.log"
mkdir -p "$LOG_DIR"
: > "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "# $SCRIPT_NAME started $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ -t 1 ] || [ -n "${FORCE_COLOR:-}" ]; then
  C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_BLUE=$'\e[34m'; C_RESET=$'\e[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_RESET=''
fi

info()  { printf '%s[info]%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()    { printf '%s[ ok ]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail()  { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_RESET" "$*"; }
die()   { fail "$*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed or not on PATH"
}

require_env_file() {
  [ -f "$REPO_ROOT/.env" ] || die ".env not found. Create it with: pnpm env:init"
}

# Exports .env into the current shell (for scripts that print ports etc.).
load_env() {
  require_env_file
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
}

# Docker in this WSL setup is socket activated: the first call after boot waits
# while dockerd starts. Poll with a bound instead of hanging forever.
wait_for_docker() {
  local timeout="${1:-90}" waited=0
  until timeout 10 docker info >/dev/null 2>&1; do
    if [ "$waited" -ge "$timeout" ]; then
      die "Docker daemon not reachable after ${timeout}s. Check: systemctl status docker"
    fi
    [ "$waited" -eq 0 ] && info "waiting for the Docker daemon..."
    sleep 3
    waited=$((waited + 3))
  done
}
