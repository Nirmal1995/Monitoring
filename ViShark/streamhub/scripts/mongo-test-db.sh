#!/usr/bin/env bash
# Grants the application user readWrite on the integration-test database
# (<MONGO_APP_DATABASE>_test). Idempotent. Needed once for data volumes created
# before Phase 3; new volumes get the grant from the init script.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
require_cmd docker
load_env
wait_for_docker

docker compose exec -T \
  -e MONGO_APP_DATABASE -e MONGO_APP_USERNAME \
  mongo mongosh --quiet \
  -u "$MONGO_ROOT_USERNAME" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  --eval '
    const db0 = db.getSiblingDB(process.env.MONGO_APP_DATABASE);
    db0.grantRolesToUser(process.env.MONGO_APP_USERNAME, [{ role: "readWrite", db: process.env.MONGO_APP_DATABASE + "_test" }]);
    printjson(db0.getUser(process.env.MONGO_APP_USERNAME).roles);
  '
ok "test database access granted"
