# Local Infrastructure

## Services

| Service        | Image                                     | Purpose                             | Host port(s)               | Volume                       |
| -------------- | ----------------------------------------- | ----------------------------------- | -------------------------- | ---------------------------- |
| `mongo`        | `mongo:8.0`                               | System of record                    | 27017                      | `mongo-data`, `mongo-config` |
| `redis`        | `redis:8.4-alpine`                        | BullMQ queues, rate limits          | 6379                       | `redis-data`                 |
| `storage`      | `pgsty/silo:RELEASE.2026-10-15T00-00-00Z` | S3-compatible object storage        | 9000 (API), 9001 (console) | `storage-data`               |
| `storage-init` | same as storage                           | One-shot: buckets, app user, policy | none                       | none                         |
| `mailpit`      | `axllent/mailpit:v1.30.5`                 | Captures outgoing email             | 1025 (SMTP), 8025 (UI)     | `mailpit-data`               |

All services share the `streamhub-backend` network and publish ports on `127.0.0.1` only. Compose project name: `streamhub`.

## Startup sequence

```
pnpm infra:up
  └─ docker compose up -d --wait
       ├─ mongo      entrypoint wrapper → keyfile → mongod --replSet rs0 --keyFile
       │             first start only: create root user, run 10-app-user.js
       │             healthcheck: rs.initiate() if needed, healthy when PRIMARY
       ├─ redis      requirepass + noeviction + appendonly
       ├─ storage    healthy when `mc ready local` succeeds
       │     └─ storage-init (after storage is healthy): buckets, policy, app user, exit 0
       └─ mailpit    healthy when `mailpit readyz` succeeds
```

`--wait` makes the command fail if any service does not become healthy within 240 seconds, or if `storage-init` exits non-zero.

## Credentials model

Two identities per service, mirroring production:

| Service | Admin identity   | Application identity                        | Application permissions                                                                             |
| ------- | ---------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| MongoDB | `MONGO_ROOT_*`   | `MONGO_APP_*`                               | `readWrite` on `streamhub` only                                                                     |
| Storage | `STORAGE_ROOT_*` | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | object read/write/delete and multipart on the two buckets; cannot create buckets or change policies |
| Redis   | password         | same password                               | full (Redis ACL users can be added later)                                                           |

The application (from Phase 2) only ever receives the application identities.

Important: MongoDB init scripts run **only on the first start with an empty volume**. Changing `MONGO_APP_PASSWORD` in `.env` afterwards does not change the database user. Either reset the data (`pnpm infra:reset`) or change the password in `mongosh`.

## Verification

`pnpm infra:verify` runs 15 checks from the host, using the same client libraries the app will use:

- MongoDB: connect as app user, replica set is a writable primary, transaction commits, app user cannot read `admin.system.users` or write to another database.
- Redis: auth, round trip, `noeviction` policy, unauthenticated client rejected.
- Storage: both buckets reachable with app credentials, object round trip, anonymous GET returns 403, app user cannot create buckets.
- Mail: SMTP send arrives in Mailpit (found via its API, then deleted).

The negative checks matter as much as the positive ones: they prove the security settings are in effect, not just that the service is running.

## Troubleshooting

| Symptom                                           | Likely cause                                                                 | Fix                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| First Docker command hangs for a while after boot | Docker is socket activated; dockerd is starting and restarting containers    | Wait. Scripts poll for up to 90 s                                                   |
| `required variable ... is missing a value`        | `.env` missing or incomplete                                                 | `pnpm env:init` (or compare with `.env.example`)                                    |
| `mongo` stays `starting` / unhealthy              | replica set not initiated yet, or wrong root password for an existing volume | `pnpm infra:logs mongo`; if the volume predates your current `.env`, reset data     |
| `Authentication failed` for app user              | `.env` regenerated after the volume was created                              | `pnpm infra:reset`, then `pnpm infra:up`                                            |
| `getaddrinfo ENOTFOUND mongo` from the host       | connection string without `directConnection=true`                            | use the `MONGO_URL` from `.env.example`                                             |
| `storage-init` exited with an error               | storage not ready or wrong root credentials                                  | `pnpm infra:logs storage-init`                                                      |
| `bind: address already in use`                    | another process has the port                                                 | change the port in `.env`, or stop the other process                                |
| `pull access denied for minio/minio`              | upstream MinIO images were deleted                                           | we use `pgsty/silo` (ADR-005)                                                       |
| `.env` shows `/bin/sh^M` style errors in scripts  | CRLF line endings                                                            | repo enforces LF via `.gitattributes`; re-checkout or run `sed -i 's/\r$//' <file>` |

Useful commands:

```bash
docker compose ps -a                                  # status incl. exited one-shot jobs
docker compose logs --tail=200 mongo                  # recent logs
docker compose exec mongo mongosh -u root -p          # admin shell (prompts for password)
docker compose exec redis redis-cli ping              # uses REDISCLI_AUTH from the container env
docker volume ls --filter label=com.docker.compose.project=streamhub
docker system df                                      # disk used by images, volumes, cache
```

## Disk usage

Images, volumes and build cache live inside the WSL virtual disk (`ext4.vhdx` on C:). Container logs are capped at 3 x 10 MB per service. To reclaim space: `docker image prune`, `docker builder prune`, and compact the vhdx from Windows after `wsl --shutdown` (documented later in the operations guide).

## Development vs production

| Concern        | Local                                      | AWS (planned)                                     |
| -------------- | ------------------------------------------ | ------------------------------------------------- |
| Database       | MongoDB in Docker, single-node replica set | MongoDB Atlas, TLS, IP access list                |
| Queue store    | Redis container                            | ElastiCache (Redis/Valkey) with TLS and AUTH      |
| Object storage | Silo                                       | Amazon S3 + CloudFront with Origin Access Control |
| Email          | Mailpit                                    | Amazon SES                                        |
| Secrets        | `.env` with generated values               | AWS Secrets Manager                               |
