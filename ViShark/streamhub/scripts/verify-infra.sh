#!/usr/bin/env bash
# Runs the Node connectivity checks with output captured to .logs/.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
require_env_file
exec pnpm exec tsx --env-file=.env scripts/verify-infra.ts
