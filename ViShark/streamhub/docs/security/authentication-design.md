# Authentication and Session Design

Status: Phase 3a implemented (sessions, login, registration, CSRF, RBAC, admin CLI). Phase 3b adds email verification delivery, password reset, change password, account deactivation and admin TOTP MFA.

Reference: OWASP ASVS 4.0 chapters V2 (authentication), V3 (session management), V4 (access control).

## Why server-side sessions, not JWTs

| Concern                                                   | Server-side session                                       | JWT in the browser                               |
| --------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| Revocation (logout, "sign out all devices", deactivation) | delete the row, effective immediately                     | needs a denylist, which is a session store again |
| Storage in the browser                                    | opaque ID in an HttpOnly cookie, unreadable by JavaScript | often localStorage, readable by any XSS          |
| Role or status changes                                    | current on the next request                               | stale until the token expires                    |
| Cost                                                      | one indexed database read per request                     | none                                             |

The API serves one first-party web app on the same origin, so the cost is easily worth it.

## Session lifecycle

```
login ──► regenerate() ──► new random ID (192 bits) ──► cookie: HttpOnly, SameSite=Lax, Secure (prod), Path=/
            │                                              name: __Host-streamhub.sid (prod) / streamhub.sid (local)
            ▼
   session document in MongoDB:
     _id        = SHA-256(session ID)        ← a database leak does not leak usable session IDs
     session    = { userId, handle, csrfToken, createdAt, lastSeenAt, userAgent, ip }
     expires    = now + idle timeout          ← TTL index deletes it automatically
            │
every request: hash cookie value → load session → check idle (30 min) and absolute (12 h) timeouts
               → load user from DB (status and role always current) → CSRF check on state changes
            │
logout / revoke / timeout ──► document deleted ──► cookie cleared
```

- **Session fixation**: the session ID is replaced at login (`req.session.regenerate()`), and the old document is deleted. A planted or pre-login ID never becomes authenticated.
- **Timeouts are enforced on the server**, not only by cookie lifetime. Idle timeout uses `lastSeenAt`, written at most once per minute (or a quarter of the idle timeout) to limit database writes. Absolute timeout uses `createdAt` and cannot be extended by activity.
- **Handles**: listing and revoking sessions uses a separate random `handle`. Real session IDs are never sent in API responses, so even an XSS bug could not read other devices' session IDs.
- **Logout everywhere**: `DELETE /auth/sessions` deletes every other session of the user; `DELETE /auth/sessions/:handle` deletes one. Both are scoped by `userId` in the query itself.

## Passwords

- **Argon2id**, 19 MiB memory, 2 iterations, 1 lane (OWASP minimum; configurable). Salt is random per hash and stored with the parameters inside the encoded hash.
- **Rehash on login** when parameters are raised (`needsRehash`), so the whole user base upgrades gradually.
- **Policy**: 12 to 128 characters, any characters (spaces, Unicode), no composition rules. The 128 cap bounds hashing cost (denial of service via huge passwords).
- Passwords never appear in logs (redaction of `password`, `currentPassword`, `newPassword` fields) and are never returned.

## Login

1. Per-IP rate limit (Redis, 20 requests per 15 minutes; IPv6 grouped by /64).
2. Per-email failure throttle (Redis, 10 failures per 15 minutes), applied whether or not the account exists.
3. Look up the user; verify with Argon2id. **If the email is unknown, verify against a dummy hash** so the response time does not reveal whether the account exists.
4. Same `401 INVALID_CREDENTIALS` for unknown email and wrong password.
5. Only after a correct password: `403 ACCOUNT_DEACTIVATED` or `403 EMAIL_NOT_VERIFIED` (revealing account state to the password holder is acceptable).
6. Regenerate the session, store the session data, return the user and the CSRF token.

Throttling expires on its own (no permanent lockout), so an attacker cannot lock a victim out indefinitely. If Redis is unavailable, login **fails closed** with 503 rather than running without brute-force protection.

## Registration

Always `202 Accepted` with the same message, whether or not the email exists, and the password is hashed in both cases so timing matches. New accounts are `USER`, unverified. Role cannot be supplied (strict schema). With `AUTH_REQUIRE_EMAIL_VERIFICATION=true` (default) an unverified account cannot sign in; the verification email arrives in Phase 3b.

## CSRF

Three layers for cookie-authenticated requests:

1. **Origin check** on every POST/PUT/PATCH/DELETE: `Origin` must be `WEB_ORIGIN` (or an extra trusted origin); if `Origin` is absent, `Sec-Fetch-Site` must be `same-origin` or `none`. Requests with neither header are not from a browser and therefore cannot be CSRF. This layer also covers login and registration ("login CSRF").
2. **Synchronizer token** for authenticated sessions: random 256-bit token stored in the session, returned by login and `GET /auth/session`, required in `X-CSRF-Token`, compared in constant time.
3. **SameSite=Lax** cookie: browsers do not send it on cross-site POSTs.

## Authorization

- Roles `USER` and `ADMIN` map to permissions (`packages/shared/src/permissions.ts`). Routes check permissions (`requirePermission('user:manage')`), not role names.
- The user (role and status) is loaded from the database on every authenticated request: demotion or deactivation applies to the next request.
- `/users/me` has no user ID in the path, so there is nothing to tamper with (IDOR). Resource ownership checks for videos, favourites and history follow the same rule from Phase 4: every query includes the owner's ID.

## Initial administrator

`pnpm admin:create --email <email> [--name <name>]` creates a verified ADMIN. The password is read with a hidden prompt (or from stdin for automation), never from arguments. Existing users are promoted only with `--promote`. There is no default admin account in the code.

## Logged security events

`auth.register`, `auth.register.duplicate`, `auth.login.succeeded`, `auth.login.failed` (email as a truncated SHA-256 fingerprint), `auth.login.blocked` (reason), `auth.logout`, `auth.session.revoked`, `auth.session.revoked_others`, `auth.password.rehashed`, `admin.created`, `admin.promoted`. Never logged: passwords, session IDs, CSRF tokens, cookies.

## Verification

40 integration tests against real MongoDB and Redis plus unit tests cover each control above. Ten controls were deliberately disabled one at a time (session regeneration, hashed session IDs, CSRF token, Origin check, deactivation check, IDOR scoping, account throttle, verification requirement, absolute timeout, foreign-handle 404); each sabotage made at least one test fail.

## Residual risks and planned work

| Risk                                                 | Status                                                    |
| ---------------------------------------------------- | --------------------------------------------------------- |
| Unverified accounts cannot be activated yet          | Phase 3b (email verification)                             |
| No password reset or change                          | Phase 3b                                                  |
| Admin accounts protected by password only            | Phase 3b (optional TOTP MFA)                              |
| Breached-password check (ASVS 2.1.7) not implemented | planned: offline top-N list check in 3b                   |
| Session IP and user agent are stored (personal data) | shown only to the session owner; removed with the session |
