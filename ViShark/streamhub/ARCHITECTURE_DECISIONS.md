# Architecture Decision Records

Format: context, decision, consequences. Status is Accepted, Proposed (awaiting review) or Superseded.

## ADR-001: Modular monolith with three runnable apps

Status: Accepted (from spec)

- Context: one developer, interview-oriented project, later deployment to ECS.
- Decision: one repo, three processes: `web`, `api`, `worker`. The API is internally split into feature modules with no cross-module database access except through services.
- Consequences: simple to run and debug; the API and worker scale independently on ECS; modules can be extracted later if ever needed.

## ADR-002: Repo location on E: drive

Status: Accepted (2026-11-09)

- Context: the assistant can only read and write Windows drive folders, not the WSL filesystem (`\\wsl.localhost` paths are refused). Projects under `/mnt/e` cross the Windows/WSL boundary (9P), which is slower for `pnpm install`, and Linux file watchers do not see edits made from the Windows side.
- Decision: keep the repo at `E:\Jenkins\ViShark\streamhub`. Infrastructure data uses Docker named volumes (inside WSL), never bind mounts from E:. Vite and `tsx watch` use polling in dev.
- Consequences: slower installs and slightly higher CPU from polling; acceptable at this size. After the code is on GitHub, cloning into `~/projects` inside WSL is an easy switch.

## ADR-003: Node 26 LTS, TypeScript pinned to 6.0

Status: Accepted

- Context: spec prefers Node 26 LTS. Node 26 became Active LTS on 2026-10-28; all critical dependencies accept it (argon2 uses N-API, so no ABI rebuild issue). TypeScript 7.0 (native Go compiler) is out, but typescript-eslint 8.72 supports TypeScript `<6.1.0`.
- Decision: Node 26.x via nvm (`.nvmrc`), TypeScript 6.0.3 pinned.
- Consequences: type-aware linting works today; TypeScript 7 upgrade is a later, isolated change.

## ADR-004: pnpm installed globally via npm, not Corepack

Status: Accepted

- Context: Corepack is no longer distributed with Node 25 and later.
- Decision: `npm i -g pnpm@12.18.0`; `packageManager` field in root `package.json` documents the version; Dockerfiles install the same pinned version.
- Consequences: one less moving part; the version is still enforced in one place.

## ADR-005: Local object storage image

Status: Accepted (2026-11-09): `pgsty/silo:RELEASE.2026-10-15T00-00-00Z`

- Context: the spec names MinIO. MinIO Community Edition stopped publishing images in October 2025, was archived upstream in 2026, and the `minio/minio` image was removed from Docker Hub in September 2026 (quay.io now refuses anonymous pulls). The last official image is unpatched (for example CVE-2025-62506).
- Options:
  1. `pgsty/silo`: maintained community fork of MinIO (formerly `pgsty/minio`), same env vars and S3 API, console restored. Pin tag and digest.
  2. `cgr.dev/chainguard/minio`: free tier offers only `latest`, so it cannot be pinned.
  3. Build MinIO from archived source ourselves: reproducible but no security fixes.
  4. A different S3 server (Garage, SeaweedFS): actively developed but less S3-complete for multipart, CORS and presigning.
- Proposed decision: option 1, local development only, bound to 127.0.0.1, behind our S3 abstraction using the AWS SDK. Swapping to another S3 server or real S3 is a configuration change.
- Consequences: supply chain trust in a community fork for a dev-only service; documented and pinned by digest.

## ADR-006: Server-side sessions in MongoDB, no JWT

Status: Accepted (from spec)

- Context: a browser app talking to its own API; requirements include revocation, "logout all devices" and session listing.
- Decision: `express-session` with `connect-mongo`, `stringify: false` so session fields (userId, createdAt, lastSeenAt, user agent) are queryable and indexed. Opaque random IDs, regenerated on login and privilege change. Idle timeout via rolling expiry, absolute timeout checked in middleware, TTL index for cleanup.
- Consequences: instant revocation and a simple security model; one database read per request, acceptable at this scale. JWTs would make revocation hard and tempt localStorage storage.

## ADR-007: Same-origin API

Status: Accepted

- Context: cross-origin cookie auth brings CORS with credentials, third-party cookie restrictions and weaker SameSite options.
- Decision: the browser always calls `/api/v1` on the web origin. Locally the Vite dev server proxies to the API; on AWS CloudFront routes `/api/*` to the ALB. Cookies are `HttpOnly; SameSite=Lax; Secure` in production. Object storage gets an explicit CORS policy because uploads and hls.js requests go to it directly.
- Consequences: no API CORS surface; dev and prod behave the same way.

## ADR-008: Shared packages layout

Status: Accepted (2026-11-09). `packages/contracts` is created in the first phase that needs a schema.

- Context: the spec lists `packages/shared`, `types` and `validation`. With Zod, types are inferred from schemas, so separate `types` and `validation` packages would duplicate definitions.
- Decision: `packages/contracts` (Zod request/response schemas, inferred types, DTOs, used by API and web) and `packages/shared` (roles and permissions, video state machine, constants).
- Consequences: one source of truth for API shapes; the frontend validates forms with the same rules the API enforces.

## ADR-009: MongoDB as a single node replica set locally

Status: Accepted

- Context: completing an upload updates `uploads` and `videos` together; multi-document transactions need a replica set. Atlas is always a replica set.
- Decision: run MongoDB in Compose with `--replSet rs0` and an init healthcheck.
- Consequences: transactions available locally; local behaviour matches Atlas.

## ADR-010: Playback URL provider abstraction

Status: Accepted

- Context: private HLS needs authorization on the playlist and every segment; signing only the playlist leaves segments open.
- Decision: interface `PlaybackUrlProvider`. Local implementation: pre-signed MP4 URL (storage serves Range requests), and an API-served HLS playlist with each segment line rewritten to its own short-lived pre-signed URL. AWS implementation (later): CloudFront signed cookies scoped to the video path.
- Consequences: one call site in the API; the AWS change is a new implementation plus configuration.

## ADR-011: Own CSRF middleware (synchronizer token)

Status: Accepted

- Context: `csurf` is deprecated. Cookie sessions need CSRF protection on state-changing requests.
- Decision: a random token stored in the session, delivered via `GET /auth/session`, required in an `X-CSRF-Token` header on POST, PUT, PATCH and DELETE, compared in constant time. SameSite=Lax and an Origin check add defence in depth.
- Consequences: about 40 lines of owned, tested code instead of an unmaintained dependency.

## ADR-012: Local port plan and loopback binding

Status: Accepted

- Context: ports 3000, 5000, 5173, 5432, 8000, 8080, 8081, 9100 and 3306 are in use by another stack; Windows reserves 50000 to 50059 and 61539 to 62338.
- Decision: web 5273, API 4000, worker 4100, MongoDB 27017, Redis 6379, storage 9000/9001, Mailpit 1025/8025, all published on 127.0.0.1 and configurable via `.env`.
- Consequences: no conflicts; infrastructure is not reachable from the LAN.

## ADR-013: MongoDB auth with a replica set: keyfile and directConnection

Status: Accepted (Phase 1)

- Context: a replica set with authentication needs a keyfile for internal member auth, even with one member. Inside Docker the member advertises itself as `mongo:27017`, a name that does not resolve from WSL, so normal replica set discovery from the host would fail.
- Decision: a small entrypoint wrapper generates the keyfile once into the config volume. The healthcheck initiates the replica set and only reports healthy when the node is a writable primary. Host connections use `directConnection=true`; containers (later) use `mongodb://mongo:27017/?replicaSet=rs0`.
- Consequences: transactions and auth work locally like Atlas. `directConnection` is a local-only setting and must not appear in the Atlas connection string.

## ADR-014: Generated development secrets

Status: Accepted (Phase 1)

- Context: shared default passwords such as `minioadmin` end up copied into real environments.
- Decision: `.env.example` holds placeholders only. `pnpm env:init` creates `.env` with random hex secrets (hex needs no URL encoding inside connection strings), mode 600, and refuses to overwrite an existing `.env`. Compose uses `${VAR:?}` so a missing secret stops startup with a clear error.
- Consequences: no credential exists in the repository; every developer machine has unique values.

## ADR-015: Package supply-chain controls

Status: Accepted (Phase 1)

- Context: npm supply-chain attacks usually publish a malicious version that is detected and removed within hours, and often execute through install scripts.
- Decision: `minimumReleaseAge: 1440` (versions must be at least 24 hours old), install scripts blocked except an explicit `allowBuilds` list (currently only esbuild), exact versions, committed lockfile, `engineStrict`.
- Consequences: the newest release of a package is sometimes unavailable for a day (this happened during Phase 1 with typescript-eslint and the AWS SDK, so the previous patch versions were pinned). Each new native or script-running dependency (for example argon2) needs a deliberate approval.

## ADR-016: Redis configuration for BullMQ

Status: Accepted (Phase 1)

- Context: BullMQ stores jobs in Redis keys. With an eviction policy Redis may silently delete queue data under memory pressure. ElastiCache production setups require AUTH.
- Decision: `maxmemory-policy noeviction`, a password (`requirepass`), append-only persistence, 200 MB memory cap locally.
- Consequences: under memory pressure Redis returns errors instead of losing jobs, which is visible and alertable. `pnpm infra:verify` checks the policy.

## ADR-017: Structured logging with request and correlation IDs

Status: Accepted (Phase 2)

- Context: logs must be searchable in CloudWatch, traceable per request, and must never contain secrets.
- Decision: Pino JSON logs to stdout; one line per request via pino-http; `X-Request-Id` per request and `X-Correlation-Id` per user action (accepted from upstream only if they match a strict character set); query strings removed from logged URLs; redaction list applied at serialization; credentials removed from connection strings.
- Consequences: every error response carries a `requestId` that leads straight to its log line. Redaction is defence in depth, not a reason to log whole objects.

## ADR-018: Separate liveness, readiness and metrics endpoints

Status: Accepted (Phase 2)

- Context: an orchestrator restarts containers that fail liveness and stops routing to containers that fail readiness. Metrics must not be public.
- Decision: `/health/live` checks nothing external; `/health/ready` checks MongoDB with a 2 s timeout and reports not ready while draining; dependency errors are logged but not returned. Prometheus metrics are served on a second internal-only port with bounded route labels.
- Consequences: a database outage marks instances not ready (no traffic) without causing a restart storm. Readiness reveals only up/down per dependency.

## ADR-019: Mongoose safety defaults and start-before-connect

Status: Accepted (Phase 2)

- Context: query selector injection is the most common NoSQL vulnerability; queued queries during an outage hide failures; a starting API should not crash if the database is late.
- Decision: global `sanitizeFilter`, `strictQuery`, `bufferCommands=false`; `autoIndex` off in production. The HTTP server starts immediately and the first MongoDB connection is retried with capped exponential backoff, after which the driver reconnects automatically.
- Consequences: database calls fail fast with a 500 (or 503 via readiness) instead of hanging; operators see a clear "not ready" state during startup.

## ADR-020: OpenAPI generated from Zod

Status: Accepted (Phase 2)

- Context: hand-written API docs drift from the code.
- Decision: OpenAPI 3.1 document whose component schemas come from `z.toJSONSchema()` of the same schemas used by `validate()`. Swagger UI is served only when `API_DOCS_ENABLED` (default off in production), under a CSP that allows only same-origin scripts.
- Consequences: one definition per shape. Paths are still registered by hand per module; generating them from route definitions can be added if the manual list becomes a burden.

## ADR-021: Hashed session IDs and public session handles

Status: Accepted (Phase 3a)

- Context: the session ID is a bearer credential. Storing it as the document key means anyone with database read access (a backup, a misconfigured replica, a leaked dump) can impersonate every signed-in user. Listing sessions to the user must not hand out other devices' IDs either.
- Decision: connect-mongo `transformId` stores SHA-256(session ID) as `_id`. Each session also gets a random `handle` used by the session list and revoke endpoints.
- Consequences: a database leak does not yield usable sessions; the session list API cannot leak them. Lookups still use the unique `_id` index.

## ADR-022: Own Redis rate limiter, failing closed, plus a per-email throttle

Status: Accepted (Phase 3a)

- Context: limits must be shared by all API instances; behaviour when Redis is down must be deliberate; per-account protection must not reveal which accounts exist.
- Decision: a fixed-window limiter (`INCR` + `EXPIRE NX` in one `MULTI`) keyed by client IP, with IPv6 grouped by /64, returning standard `RateLimit` and `Retry-After` headers. A second counter per email fingerprint counts failed logins for any email. Redis errors become 503 (fail closed). No `express-rate-limit` dependency.
- Consequences: about 60 lines of owned, tested code. A Redis outage blocks login and registration until it recovers; readiness reports it. Fixed windows allow a burst at a window boundary, acceptable at these limits.

## ADR-023: Registration does not reveal existing accounts; verification required to sign in

Status: Accepted (Phase 3a)

- Context: "email already registered" lets anyone test whether a person has an account.
- Decision: `POST /auth/register` always returns the same 202 after the same work (the password is hashed in both cases). Signing in requires a verified email (`AUTH_REQUIRE_EMAIL_VERIFICATION`, default true). Phase 3b emails the existing owner instead of creating a duplicate.
- Consequences: the UI cannot say "this email is taken"; users are told to check their email.

## ADR-024: Isolated test namespaces and a real MongoDB in the assistant sandbox

Status: Accepted (Phase 3a)

- Context: auth tests write and delete data; they must never touch development data. The assistant sandbox cannot pull Docker images, and mocking MongoDB would not test sessions, TTL indexes or transactions faithfully.
- Decision: integration tests use database `<name>_test` and Redis DB 15, run files sequentially, and empty collections rather than dropping the database (the app user correctly lacks `dropDatabase`). `pnpm infra:test-db` grants the app user access to the test database on existing volumes. The sandbox runs MongoDB 8.3 server binaries from conda-forge with the same replica-set-plus-auth setup as the local stack.
- Consequences: the same tests run in the sandbox and on the developer machine; the sandbox uses 8.3 while the local stack uses 8.0 (differences irrelevant to these features).
