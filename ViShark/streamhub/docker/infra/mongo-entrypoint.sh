#!/usr/bin/env bash
# Wraps the official MongoDB entrypoint to run as a single-node replica set
# with authentication enabled.
#
# A replica set with auth requires a keyfile for internal member auth, even
# with one member. We generate it once and keep it in the config volume.
set -euo pipefail

KEYFILE=/data/configdb/replica.key

if [ ! -s "$KEYFILE" ]; then
  echo "[streamhub] generating replica set keyfile"
  head -c 756 /dev/urandom | base64 -w 0 > "$KEYFILE"
fi
chmod 400 "$KEYFILE"
chown 999:999 "$KEYFILE"   # mongodb user inside the image

exec docker-entrypoint.sh mongod --replSet rs0 --keyFile "$KEYFILE" --bind_ip_all
