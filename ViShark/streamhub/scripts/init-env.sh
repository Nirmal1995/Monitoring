#!/usr/bin/env bash
# Creates .env from .env.example with random development secrets.
# Refuses to overwrite an existing .env.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
require_cmd openssl

[ -f .env ] && die ".env already exists. Not overwriting. Delete or rename it yourself if you really want a new one."

PATTERN='__GENERATE_[A-Z0-9_]*__'
tmp="$(mktemp .env.tmp.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
cp .env.example "$tmp"
chmod 600 "$tmp"

# Each distinct placeholder gets one random value, reused everywhere it appears
# (for example the Mongo app password inside MONGO_URL).
placeholders="$(grep -o "$PATTERN" "$tmp" | sort -u)"
[ -n "$placeholders" ] || die "no placeholders found in .env.example"
for ph in $placeholders; do
  sed -i "s/${ph}/$(openssl rand -hex 24)/g" "$tmp"
done

if grep -q "$PATTERN" "$tmp"; then die "unreplaced placeholders remain"; fi
mv "$tmp" .env
trap - EXIT
ok ".env created with $(echo "$placeholders" | wc -l) generated secrets (permissions 600)"
info "Secret values are not printed. Open .env if you need them (e.g. for the storage console)."
