#!/usr/bin/env bash
# Checks that this machine has everything StreamHub needs. Read-only.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

problems=0
check() { if "$@"; then :; else problems=$((problems + 1)); fi; }

expect_version() {
  # $1 label, $2 command, $3 regex the version output must match, $4 hint
  local out
  if ! out="$(eval "$2" 2>&1)"; then fail "$1: not found. $4"; return 1; fi
  if [[ "$out" =~ $3 ]]; then ok "$1: $out"; else fail "$1: $out (expected $3). $4"; return 1; fi
}

expect_linux_binary() {
  local path; path="$(command -v "$1" || true)"
  if [ -z "$path" ]; then fail "$1 not on PATH"; return 1; fi
  case "$path" in
    /mnt/*) fail "$1 resolves to a Windows binary ($path). Install it inside WSL."; return 1 ;;
    *) ok "$1 -> $path" ;;
  esac
}

info "Toolchain"
check expect_version "node" "node -v" '^v26\.' "Run: nvm install 26 && nvm alias default 26"
check expect_version "pnpm" "pnpm -v" '^12\.18\.' "Run: npm install -g pnpm@12.18.0"
check expect_version "git" "git --version" '^git version 2\.' "Run: sudo apt install -y git"
check expect_version "ffmpeg" "ffmpeg -version | head -1" '^ffmpeg version' "Run: sudo apt install -y ffmpeg"
check expect_version "ffprobe" "ffprobe -version | head -1" '^ffprobe version' "Run: sudo apt install -y ffmpeg"
check expect_linux_binary node
check expect_linux_binary pnpm

info "Docker"
check expect_version "docker" "docker --version" '^Docker version' "Install Docker Engine in WSL"
check expect_version "compose" "docker compose version --short" '^v?[2-9]\.' "Install the docker compose plugin"
if timeout 60 docker info >/dev/null 2>&1; then
  ok "docker daemon reachable"
else
  fail "docker daemon not reachable within 60s (systemctl status docker)"
  problems=$((problems + 1))
fi

info "Ports (127.0.0.1)"
our_containers="$(docker ps --filter label=com.docker.compose.project=streamhub -q 2>/dev/null | wc -l)"
for port in 4000 4100 5273 27017 6379 9000 9001 1025 8025; do
  if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
    if [ "$our_containers" -gt 0 ]; then
      warn "port $port in use (StreamHub infra is running, probably ours)"
    else
      fail "port $port already in use by something else"
      problems=$((problems + 1))
    fi
  else
    ok "port $port free"
  fi
done

info "Disk"
df -h "$REPO_ROOT" | tail -1 | awk '{print "repo drive free: " $4}'
df -h / | tail -1 | awk '{print "WSL disk free:   " $4 " (real limit is free space on the Windows drive holding ext4.vhdx)"}'

echo
if [ "$problems" -eq 0 ]; then
  ok "doctor: all checks passed"
else
  die "doctor: $problems problem(s) found"
fi
