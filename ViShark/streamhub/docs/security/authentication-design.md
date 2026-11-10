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
- **Expired versus missing**: a request that carries a session cookie the server no longer accepts (timed out, revoked, deleted) gets `401 SESSION_EXPIRED`; a request with no cookie gets `401 UNAUTHENTICATED`. The UI can then say "your session expired, please sign in again" instead of a generic error. This reveals nothing new: the caller already holds the cookie.

## Passwords

- **Argon2id**, 19 MiB memory, 2 iterations, 1 lane (OWASP minimum; configurable). Salt is random per hash and stored with the parameters inside the encoded hash.
- **Rehash on login** when parameters are raised (`needsRehash`), so the whole user base upgrades gradually.
- **Policy**: 12 to 128 characters, any characters (spaces, Unicode), no composition rules. The 128 cap bounds hashing cost (denial of service via huge passwords).
- **Common-password check** (ASVS 2.1.7, NIST 800-63B): the password is rejected with `400 WEAK_PASSWORD` if, ignoring case, it appears in a bundled list of 1,186 common passwords of 12+ characters (SecLists NCSC top 100k, MIT licence, filtered by length; `apps/api/assets/common-passwords.txt`), or if it equals the user's email. Checked offline: nothing is sent to a third party. Applied at registration, reset, change and `admin:create`.
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

Always `202 Accepted` with the same message, whether or not the email exists, and the password is hashed in both cases so timing matches. New accounts are `USER`, unverified. Role cannot be supplied (strict schema). With `AUTH_REQUIRE_EMAIL_VERIFICATION=true` (default) an unverified account cannot sign in. A new account gets a verification email; if the email is already registered, the **existing owner** gets a notice instead ("someone tried to create an account with your email"), so the owner learns about the attempt and the requester learns nothing.

## Email flows (Phase 3b-1)

**Tokens** (verification and password reset) are 256-bit random values, base64url, 43 characters.

- Only the **SHA-256 hash** is stored (`emailVerificationTokens`, `passwordResetTokens`), so a database leak does not leak usable links.
- **Single use**: consumed with one atomic `findOneAndDelete`; of two concurrent requests with the same token, exactly one succeeds.
- **Expiry**: verification 24 h, reset 30 min (configurable). Checked in the query and also removed by a TTL index.
- Issuing a new token deletes the user's older ones of the same kind, so only the latest email works.
- The link puts the token in the **URL fragment** (`/verify-email#token=...`). Browsers never send the fragment to a server, so it does not land in web server logs, proxies or `Referer` headers. The web page reads it and POSTs it.
- Any bad, used or expired token gets the same `400 INVALID_TOKEN`.

| Endpoint                         | Who         | Behaviour                                                                                                                                           |
| -------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/verify-email`        | anyone      | marks the email verified                                                                                                                            |
| `POST /auth/resend-verification` | anyone      | always `202`; emails only an active, unverified account                                                                                             |
| `POST /auth/forgot-password`     | anyone      | always `202`, same time for known and unknown emails                                                                                                |
| `POST /auth/reset-password`      | link holder | new password (policy checked **before** the token is used up); revokes **every** session and other reset tokens; marks email verified; notice email |
| `POST /auth/change-password`     | signed in   | requires the current password; revokes other sessions, rotates the current one (new ID and CSRF token, returned); notice email                      |
| `POST /users/me/deactivate`      | signed in   | requires the password; status `DEACTIVATED`, all sessions revoked, cookie cleared, notice email; `204`                                              |

**Anti-enumeration and anti-abuse**

- Emails are sent **in the background** after the response is decided, so SMTP latency cannot reveal whether an address has an account.
- At most `AUTH_EMAIL_LIMIT_PER_HOUR` (default 3) emails of each kind per address per hour, counted whether or not the account exists. Over the limit the caller still gets the normal response; the email is skipped and `auth.email.limited` is logged. This stops the app from being used to flood someone's inbox.
- The usual per-IP limits apply to all of these endpoints.
- Email templates HTML-escape every value (display names are user input).

**Local delivery** goes to Mailpit (SMTP 127.0.0.1:1025, inbox at http://127.0.0.1:8025). In AWS this becomes Amazon SES; only the `SMTP_*` settings change.

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

See the table in [observability](../operations/observability.md#security-events). Never logged: passwords, session IDs, CSRF tokens, cookies, verification or reset tokens, email links.

## Verification

69 integration tests against real MongoDB, Redis and Mailpit plus 86 API unit tests cover the controls above, run with exactly the production Mongoose settings. Twenty controls were deliberately disabled one at a time; each sabotage made at least one test fail:

- Phase 3a: session regeneration, hashed session IDs, CSRF token, Origin check, deactivation check, IDOR scoping, account throttle, verification requirement, absolute timeout, foreign-handle 404.
- Phase 3b-1: token single use, token hashing, token expiry, session revocation on reset, current-password check on change, password check on deactivate, per-address email cap, common-password list, `SESSION_EXPIRED`, HTML escaping in emails.

A real-server run (register, read the email from Mailpit, verify, sign in, change, forgot, reset, deactivate) passed 20/20 checks, and no token or password appeared in the logs.

## Residual risks and planned work

| Risk                                                      | Status                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| Admin accounts protected by password only                 | Phase 3b-2 (TOTP MFA)                                                   |
| Common-password list is offline and small (1,186 entries) | accepted; an online k-anonymity breach check could be added later       |
| Email is a single factor for account recovery             | accepted for users; admins get MFA in 3b-2                              |
| A deactivated account cannot be reactivated by the user   | by design; reactivation will be an admin action (admin user management) |
| Session IP and user agent are stored (personal data)      | shown only to the session owner; removed with the session               |
| Not yet reviewed by a second party                        | security review before any production claim (Phase 9)                   |
