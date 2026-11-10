#!/usr/bin/env bash
# Adds settings that exist in .env.example but are missing from .env.
# Existing values are never changed. New GENERATE placeholders get random values.
# Run after pulling changes that introduce new settings.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
require_cmd openssl
require_env_file

added=0
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)= ]] || continue
  key="${BASH_REMATCH[1]}"
  if grep -qE "^${key}=" .env; then continue; fi
  if [[ "$line" =~ __GENERATE_[A-Z0-9_]*__ ]]; then
    line="$(printf '%s' "$line" | sed -E "s/__GENERATE_[A-Z0-9_]*__/$(openssl rand -hex 24)/g")"
    info "added $key (generated)"
  else
    info "added $key (default from .env.example)"
  fi
  [ "$added" -eq 0 ] && printf '\n# ---- added by env:sync on %s ----\n' "$(date -u +%Y-%m-%d)" >> .env
  printf '%s\n' "$line" >> .env
  added=$((added + 1))
done < .env.example

if [ "$added" -eq 0 ]; then ok ".env already has every setting"; else ok "$added setting(s) added to .env"; fi
