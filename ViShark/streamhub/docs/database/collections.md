# MongoDB Collections

Database: `streamhub` (application) and `streamhub_test` (integration tests only). The application connects as `streamhub_app` with `readWrite` on both, and nothing else.

Status: collections are added here as each phase introduces them.

## users

| Field                    | Type                      | Notes                                                                  |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------- |
| `_id`                    | ObjectId                  |                                                                        |
| `email`                  | string                    | required, trimmed, lowercase, max 254, **unique index**                |
| `passwordHash`           | string                    | Argon2id encoded hash, `select: false` (never loaded unless asked for) |
| `displayName`            | string                    | required, max 60                                                       |
| `role`                   | `USER` \| `ADMIN`         | default `USER`                                                         |
| `status`                 | `ACTIVE` \| `DEACTIVATED` | default `ACTIVE`                                                       |
| `emailVerifiedAt`        | Date \| null              |                                                                        |
| `passwordChangedAt`      | Date \| null              | set by password change/reset (Phase 3b)                                |
| `lastLoginAt`            | Date \| null              |                                                                        |
| `createdAt`, `updatedAt` | Date                      | Mongoose timestamps                                                    |

Schema mode `strict: 'throw'`: writing an unknown field is an error, not silently dropped.

Indexes: `{ email: 1 }` unique.

API responses use `UserDto` (`id, email, displayName, role, emailVerified, createdAt`); the document is never returned directly.

## sessions

Managed by `connect-mongo` (`stringify: false`, so fields are queryable).

| Field                             | Type           | Notes                                                        |
| --------------------------------- | -------------- | ------------------------------------------------------------ |
| `_id`                             | string         | **SHA-256 of the session ID**, not the ID itself             |
| `expires`                         | Date           | idle-timeout expiry; **TTL index** removes expired documents |
| `lastModified`                    | Date           | used by connect-mongo `touchAfter`                           |
| `session.cookie`                  | object         | cookie settings                                              |
| `session.userId`                  | string         | owner                                                        |
| `session.handle`                  | string         | public random identifier for listing/revoking                |
| `session.csrfToken`               | string         | synchronizer token                                           |
| `session.createdAt`               | number (ms)    | absolute timeout                                             |
| `session.lastSeenAt`              | number (ms)    | idle timeout                                                 |
| `session.userAgent`, `session.ip` | string \| null | shown to the owner in "my sessions"                          |

Indexes: `{ expires: 1 }` TTL (`expireAfterSeconds: 0`, created by connect-mongo), `{ 'session.userId': 1 }` (list and revoke by user).

## emailVerificationTokens and passwordResetTokens

Same shape for both (one Mongoose model each, `src/modules/auth/tokens.ts`).

| Field       | Type     | Notes                                                                    |
| ----------- | -------- | ------------------------------------------------------------------------ |
| `_id`       | ObjectId |                                                                          |
| `userId`    | ObjectId | owner; indexed                                                           |
| `tokenHash` | string   | **SHA-256 of the token**, unique; the token itself is only in the email  |
| `expiresAt` | Date     | verification 24 h, reset 30 min; **TTL index** (`expireAfterSeconds: 0`) |
| `createdAt` | Date     |                                                                          |

Lifecycle: issuing a token deletes the user's older tokens of that kind; using one deletes it atomically (`findOneAndDelete`); a successful reset deletes all of the user's reset tokens. Expired documents are removed by MongoDB within about a minute, and the query also rejects them, so the TTL delay is never a window.

## Relationships

```
users 1 ──── * sessions                  (session.userId → users._id as string)
users 1 ──── * emailVerificationTokens   (userId)
users 1 ──── * passwordResetTokens       (userId)
```

Collections still to come: videos, categories, uploads, favourites, watchHistory, auditLogs.
