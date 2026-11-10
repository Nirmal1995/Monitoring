# Development Log

## 2026-11-09: Phase 0, environment inspection and architecture

### Completed

- Wrote read-only inspection scripts (`E:\Jenkins\ViShark\phase0\`) for the Windows host and WSL.
- Collected and analysed both reports.
- Verified current versions of Node.js and all critical dependencies against the npm registry and the Node release schedule.
- Produced `docs/architecture/phase-0-environment-and-plan.md` and ADR-001 to ADR-012.

### Decisions

- Node 26 LTS, pnpm 12.18 via npm, TypeScript pinned to 6.0.3 (ADR-003, ADR-004).
- Same-origin API, server-side Mongo sessions, own CSRF middleware (ADR-006, 007, 011).
- Proposed: repo stays on E: (ADR-002), MinIO fork `pgsty/silo` for local storage (ADR-005), merged `contracts` package (ADR-008).

### Errors encountered

1. WSL script hung at `docker version`.
   - Root cause: Docker Engine in WSL is socket activated; the first CLI call waited while dockerd started and restarted existing containers.
   - Resolution: added `timeout` to every Docker step in both scripts. Future scripts will wait for the daemon with a bounded retry.
2. `corepack` in WSL failed with `/bin/sh^M: bad interpreter`.
   - Root cause: WSL appends the Windows PATH, so the Windows Node install's CRLF shell shim was found.
   - Resolution (planned): install Node and pnpm inside WSL so Linux binaries come first.
3. `minio/minio` image no longer available.
   - Root cause: upstream discontinued the community edition and removed the images.
   - Resolution: ADR-005 proposal.

### Outcome

- Plan approved 2026-11-09 (ADR-002, ADR-005, ADR-008 accepted). Prerequisites installed by the user.

## 2026-11-09: Phase 1, project foundation

### Completed

- pnpm workspace (`apps/*`, `packages/*`), TypeScript 6.0 strict base config, ESLint 10 flat config with type-aware rules, Prettier, Vitest, EditorConfig, LF enforcement.
- `packages/shared` with the `Role` type and tests (proves typecheck, lint and test run across the workspace).
- Docker Compose: MongoDB 8.0 (auth + single-node replica set), Redis 8.4 (auth, noeviction), Silo storage + idempotent init job (private buckets, least-privilege app user), Mailpit. Health checks, named volumes, loopback-only ports, memory limits, log rotation.
- Scripts: `doctor`, `env:init`, `infra:up/down/status/logs/verify/reset`, all logging to `.logs/`.
- `scripts/verify-infra.ts`: 14 positive and negative checks.
- Docs: README, `docs/operations/local-infrastructure.md`, ADR-013 to ADR-016.

### Validation done in the assistant sandbox (before handing over)

- `pnpm install`, `pnpm check` (typecheck, lint, format, tests): pass.
- Planted type errors in `packages/shared` and `scripts/` are caught by `pnpm typecheck`.
- `docker compose config`: valid. ShellCheck: clean.
- `env:init`: generates 5 secrets, mode 600, refuses to overwrite.
- Redis checks run against a real Redis, plus two negative controls (wrong eviction policy, no password) that correctly fail.
- Not possible in the sandbox (registry blocked): pulling images and starting the stack. That is done on the user's machine.

### Errors encountered

1. `pnpm install` rejected typescript-eslint 8.72.2 and @aws-sdk/client-s3 3.1165.0.
   - Root cause: both were published less than 24 h earlier; `minimumReleaseAge` blocked them (working as intended).
   - Resolution: pinned the newest versions older than 2 days (8.72.1, 3.1164.0).
2. `ERR_PNPM_IGNORED_BUILDS` for esbuild.
   - Root cause: pnpm 12 fails the install when a dependency wants to run an install script that is not approved.
   - Resolution: approved esbuild explicitly in `allowBuilds`.
3. `init-env` reported unreplaced placeholders.
   - Root cause: the explanatory comment in `.env.example` contained the placeholder prefix.
   - Resolution: reworded the comment; the script now writes to a temp file and only moves it into place when complete.
4. Redis negative check failed with `Connection is closed`.
   - Root cause: ioredis 6 sends `HELLO` during connect, so Redis rejects an unauthenticated client at handshake time, not at the first command.
   - Resolution: the check collects errors from both the connection and the command and requires a `NOAUTH` reply.

5. `pnpm lint` appeared to hang on the user's machine.
   - Investigation: ran ESLint against the user's folder with `--debug`, a module-load trace, `strace` and per-module timing. The process was not deadlocked: it was waiting on the filesystem for each of thousands of `stat`/`open` calls (around 10 ms each) while loading typescript-eslint and the TypeScript type definitions.
   - Root cause: repo on NTFS accessed from Linux (ADR-002 trade-off). Not a configuration error.
   - Resolution: no code change; documented in the README. `pnpm check` completed and passed on the user's machine. Long-term option: clone into the WSL filesystem after the GitHub push.
6. `pnpm doctor` ran pnpm's own built-in diagnostics instead of our script.
   - Root cause: pnpm 12 has a built-in `doctor` command, which takes precedence over a package script with the same name.
   - Resolution: renamed the script to `env:check`.

### Acceptance results (user's machine, 2026-11-09)

| Criterion                                              | Result                                    |
| ------------------------------------------------------ | ----------------------------------------- |
| `pnpm install`                                         | pass                                      |
| `pnpm check` (typecheck, lint, format, 7 tests)        | pass (lint slow on `/mnt/e`, see error 6) |
| All 4 services healthy (`pnpm infra:up`)               | pass                                      |
| Connectivity and security checks (`pnpm infra:verify`) | 15/15 pass                                |
| `pnpm env:check`                                       | pending (renamed script)                  |

### Outcome

- Phase 1 approved by the user on 2026-11-10.

## 2026-11-10: Phase 2, backend foundation

### Completed

- `apps/api`: Express 5 app factory (`app.ts`) separated from process startup (`server.ts`).
- Configuration: Zod-validated environment, fail-fast with all problems listed, values never echoed.
- Logging: Pino JSON, request and correlation IDs (strictly validated when supplied by upstream), redaction list, pretty mode for local only.
- Errors: `AppError` hierarchy, single error handler, standard envelope, 400/404/413/415/500 mapping, no internals in responses.
- Validation middleware with strict Zod schemas (blocks mass assignment and operator injection).
- MongoDB: Mongoose with `sanitizeFilter`, `strictQuery`, no command buffering; credentials redacted in logs; start-before-connect with capped exponential backoff.
- Health: `/health/live` (no dependencies), `/health/ready` (MongoDB ping with timeout, not ready while draining).
- Metrics: Prometheus on internal port 4001 with bounded route labels.
- OpenAPI 3.1 from Zod, Swagger UI at `/api/docs` with its own CSP.
- Graceful shutdown on SIGTERM/SIGINT with a hard deadline; fatal exit on unhandled rejections.
- Docs: `docs/api/conventions.md`, `docs/operations/observability.md`, ADR-017 to ADR-020.

### Validation done in the assistant sandbox

- 37 unit tests (config, health service, URL redaction, full app via Supertest) pass; `pnpm check` passes.
- Mutation checks: deliberately broke error masking, request ID validation and draining logic; tests failed each time. Removing `app.disable('x-powered-by')` did not fail the test because Helmet also removes the header (two layers).
- Ran the real server without MongoDB: live 200, ready 503 with backoff retries, metrics only on the internal port, password absent from logs, SIGTERM exit 0, missing config exits 1 with a clear message.
- Compiled build (`tsc` to `dist/`) runs under plain `node`.
- Not possible in the sandbox: the MongoDB integration tests (run on the user's machine).

### Errors encountered

1. TypeScript `erasableSyntaxOnly` rejected constructor parameter properties. Root cause: that syntax generates code, which Node's built-in type stripping cannot handle. Fix: explicit fields.
2. Module augmentation of `express-serve-static-core` failed. Root cause: pnpm's strict layout does not expose transitive type packages. Fix: augment the global `Express.Request` interface; renamed our field to `requestId` to avoid clashing with pino-http's `req.id` type.
3. `pnpm install` failed on `@scarf/scarf` install script. Root cause: `swagger-ui-dist` depends on an install-time analytics package. Fix: explicitly denied in `allowBuilds`.
4. Each failed MongoDB connection attempt was logged twice (driver event plus retry loop). Fix: the retry loop logs only the retry decision.
5. `tsx watch` does not see edits made from the Windows side on `/mnt/e` (no inotify events). Fix: dev script enables chokidar polling (`CHOKIDAR_USEPOLLING=1`).

6. Found by the user on the running API: the request log `msg` showed `GET / 301` and `GET /swagger-ui.css` for requests to `/api/docs/...`, while the `path` field was correct.
   - Root cause: Express rewrites `req.url` inside routers mounted with `app.use('/api/docs', ...)`; the message template used `req.url` instead of `req.originalUrl`.
   - Resolution: one `pathOf()` helper (originalUrl, query string removed) used by the serializer, the messages and the health-probe filter. Regression tests assert on real log output through the production logger configuration; reintroducing the bug fails two tests.
7. My first fix attempt for error 6 did not apply: the scripted search-and-replace targeted text that Prettier had since reformatted, and failed silently. The new regression test exposed it.
   - Lesson: rewrite whole files (or assert the replacement happened) instead of blind string replacement, and let a test prove each fix.

### Acceptance results (user's machine, 2026-11-10)

| Criterion                                                                                                                            | Result |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `pnpm env:check`                                                                                                                     | pass   |
| `pnpm check` (typecheck, lint, format, 49 unit tests)                                                                                | pass   |
| `pnpm test:integration` (3 tests against real MongoDB)                                                                               | pass   |
| API starts, connects, serves `/health/*`, `/api/v1`, Swagger UI, metrics on 4001                                                     | pass   |
| Real outage: `docker compose stop mongo` makes readiness `not_ready`; after `start` it returns to `ready` without restarting the API | pass   |

Observation: the integration run took 180 s, 97% of it module import time across the Windows/WSL filesystem boundary (the test itself ran in 0.6 s). Strengthens the case for cloning into the WSL filesystem after the GitHub push.

### Outcome

- Phase 2 complete on 2026-11-10.

## 2026-11-10: Phase 3a, authentication core

Decisions confirmed with the user: split Phase 3 into 3a/3b; idle timeout 30 min, absolute 12 h; admin TOTP MFA in 3b.

### Completed

- `packages/contracts` (Zod schemas shared with the future web app) and `packages/shared` permissions table.
- `users` model (unique normalised email, hidden password hash, strict schema) and DTO.
- Argon2id hashing with rehash-on-login and timing-equalised verification for unknown emails.
- Server-side sessions (express-session + connect-mongo): hashed session IDs, public handles, regeneration at login, server-enforced idle/absolute timeouts, TTL cleanup.
- CSRF: Origin / Sec-Fetch-Site check plus synchronizer token.
- Redis rate limiting per IP (IPv6 /64) and per-email failure throttling, failing closed.
- Endpoints: `GET /auth/session`, `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET/DELETE /auth/sessions`, `DELETE /auth/sessions/:handle`, `GET/PATCH /users/me`.
- RBAC middleware (`requireAuth`, `requirePermission`) with the user reloaded on each request.
- `admin:create` CLI; `env:sync` and `infra:test-db` scripts; Redis added to readiness.
- OpenAPI paths for all new endpoints; docs: authentication design, database collections, security events; ADR-021 to ADR-024.

### Validation done in the assistant sandbox

- Obtained MongoDB 8.3 server binaries from conda-forge (Docker Hub and MongoDB downloads are blocked in the sandbox) and configured it like the local stack (replica set, keyfile, root + least-privilege app user). The Phase 2 integration tests passed against it first, confirming parity.
- 89 API unit tests, 27 package tests, 45 integration tests (registration, login, enumeration, NoSQL injection, login CSRF, rehash, hashed session storage, fixation, CSRF token, logout replay, idle and absolute timeouts, account and IP throttling, Redis outage, RBAC, live role change, deactivation, profile mass assignment, IDOR on users and sessions, session list/revoke, MongoDB outage, admin CLI).
- Sabotage check: ten security controls disabled one at a time; every one made tests fail.
- End-to-end with curl against the running server: admin CLI, register, unverified login refused, login, cookie flags, session list, CSRF refusal and success, logout, cookie replay refused; no passwords or tokens in logs.

### Errors encountered

1. `pnpm install` blocked argon2's install script. Root cause: install scripts are denied unless approved (ADR-015). Fix: approved argon2 (it selects its prebuilt native binary).
2. Session timeout fields typed as optional by express-session. Fix: treat missing timestamps as expired.
3. Integration reset failed with "not authorized ... dropDatabase". Root cause: the app user has readWrite only, correctly without dbAdmin. Fix: empty collections instead of dropping the database. (The least-privilege setup working as intended.)
4. Fixation test failed: the second login reused an authenticated session without the CSRF token, so it was correctly rejected; the rolling cookie made the old ID reappear. Fix: test sends the token and separately asserts the rejection.
5. Phase 2 MongoDB integration test failed after `SESSION_SECRET` became required. Fix: shared test configuration helper.

6. On the user's machine, all 5 `admin:create` CLI tests timed out (40/45 integration tests passed).
   - Root cause: each test started the CLI as a fresh Node process, which re-loads TypeScript, Mongoose and argon2 across the `/mnt/e` boundary: about 45 s per launch there versus about 2 s in the sandbox. The tests also used `spawnSync`, which blocks Vitest's event loop, so even the cleanup hook timed out.
   - Resolution: logic moved to `modules/admin/admin-bootstrap.ts` and tested in-process (argument parsing as unit tests, create/idempotent/promote/policy as integration tests). One end-to-end smoke test still launches the real command, with non-blocking `spawn` and a 180 s timeout. The CLI itself was never broken: the user created their admin with it.
7. Mongoose 9 deprecation warning for the `new` option of `findByIdAndUpdate`. Fix: `returnDocument: 'after'`.

### Acceptance results (user's machine, first run)

| Criterion                                                                    | Result                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` (argon2 install script approved), `env:sync`, `infra:test-db` | pass                                                                                                                                                             |
| `pnpm admin:create`                                                          | pass (admin created)                                                                                                                                             |
| `pnpm check` (typecheck, lint, format, 98 unit and package tests)            | pass                                                                                                                                                             |
| `pnpm test:integration`                                                      | 40/45 on first run; after the fix for error 6, `create-admin.test.ts` 5/5 (the real CLI launch took 56 s, confirming the diagnosis) and `admin-args.test.ts` 7/7 |
| Manual check in Swagger UI (login, CSRF token, sessions, profile)            | pending                                                                                                                                                          |

### Pending (user)

- `pnpm install`, `pnpm env:sync`, `pnpm infra:test-db`, `pnpm admin:create ...`, `pnpm check`, `pnpm test:integration`, manual login via Swagger UI.
