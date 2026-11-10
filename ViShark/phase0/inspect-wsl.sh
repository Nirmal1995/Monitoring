#!/usr/bin/env bash
# StreamHub Phase 0: WSL inspection (read-only; only writes wsl-report.txt next to this script)
OUT="$(cd "$(dirname "$0")" && pwd)/wsl-report.txt"
sec(){ printf '\n===== %s =====\n' "$1"; }
run(){ local l="$1"; shift; sec "$l"; "$@" 2>&1 || echo "(exit code $?)"; }
{
run 'OS' cat /etc/os-release
run 'Kernel' uname -a
run 'User' id
run 'CPU count' nproc
run 'Memory' free -h
run 'Disk: WSL home' df -h "$HOME"
run 'Disk: E drive' df -h /mnt/e
run 'PID 1 (systemd?)' ps -p 1 -o comm=
for c in node npm pnpm corepack git; do sec "$c"; if p=$(command -v "$c"); then echo "$p"; "$c" --version 2>&1; else echo 'not installed'; fi; done
for c in ffmpeg ffprobe; do sec "$c"; if p=$(command -v "$c"); then echo "$p"; "$c" -version 2>&1 | head -1; else echo 'not installed'; fi; done
sec 'Node version managers'; [ -s "$HOME/.nvm/nvm.sh" ] && echo 'nvm present' || echo 'nvm not found'; command -v fnm volta 2>/dev/null || true
sec 'Docker source'; command -v docker && readlink -f "$(command -v docker)"; systemctl is-active docker 2>&1; ls -l /var/run/docker.sock 2>&1
run 'Docker CLI' timeout 30 docker version
run 'Docker compose' timeout 30 docker compose version
run 'Docker contexts' timeout 30 docker context ls
run 'Docker info' timeout 30 docker info --format 'Server={{.ServerVersion}} OS={{.OperatingSystem}} CPUs={{.NCPU}} MemBytes={{.MemTotal}}'
run 'Docker hello-world' timeout 120 docker run --rm hello-world
run 'Groups' groups
run 'Listening TCP ports' ss -ltn
run 'Candidate project dirs' bash -c 'ls -ld ~/projects ~/src ~/code 2>&1'
run 'Git identity set?' bash -c 'git config --global user.name || echo "user.name not set"; git config --global user.email >/dev/null && echo "user.email set" || echo "user.email not set"'
} > "$OUT" 2>&1
echo "Report written to $OUT"
