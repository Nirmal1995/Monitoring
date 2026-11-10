# API Conventions

## Base path and versioning

All application endpoints live under `/api/v1`. Health probes live outside the versioned path (`/health/live`, `/health/ready`) because load balancers and orchestrators depend on them and they must never change with an API version.

A breaking change means a new prefix (`/api/v2`) served alongside `v1` until clients migrate. Additive changes (new fields, new endpoints) stay in `v1`.

## Response envelope

Success:

```json
{ "data": { "...": "..." }, "meta": { "page": 1, "pageSize": 20, "total": 134 } }
```

Failure:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Request validation failed",
    "requestId": "9a1c0f5e-6f7e-4a1b-9a53-2a6b8e3d2f10",
    "details": [{ "location": "body", "path": "title", "message": "Too small" }]
  }
}
```

`code` is stable and meant for programs; `message` is for humans and may change. `requestId` matches the `X-Request-Id` response header and the server log line, so a user can quote it in a bug report.

## Status codes

| Status | Code                     | When                                                                                                  |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`            | validation failed (`details` lists each field)                                                        |
| 400    | `INVALID_JSON`           | body is not parseable JSON                                                                            |
| 401    | `UNAUTHENTICATED`        | no valid session                                                                                      |
| 403    | `FORBIDDEN`              | authenticated but not allowed                                                                         |
| 404    | `NOT_FOUND`              | unknown route or resource (also used instead of 403 where revealing existence would leak information) |
| 409    | `CONFLICT`               | duplicate or invalid state transition                                                                 |
| 413    | `PAYLOAD_TOO_LARGE`      | body over `API_BODY_LIMIT` (default 100 kB)                                                           |
| 415    | `UNSUPPORTED_MEDIA_TYPE` | unsupported charset                                                                                   |
| 500    | `INTERNAL_ERROR`         | anything unexpected; details are logged, never returned                                               |
| 503    | none                     | readiness probe only                                                                                  |

## Validation

Every route declares Zod schemas for `params`, `query` and `body` through the `validate()` middleware. Schemas are strict: unknown fields are rejected, which blocks mass assignment (for example sending `"role": "ADMIN"` on a profile update). Values that must be strings cannot arrive as objects, which blocks NoSQL operator injection (`{"$ne": null}`).

Query strings use Express's "simple" parser, so `?a[b]=1` is not turned into a nested object.

## Headers

| Header                    | Direction | Purpose                                                                               |
| ------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `X-Request-Id`            | both      | unique per request; accepted from upstream only if it matches `[A-Za-z0-9._-]{8,128}` |
| `X-Correlation-Id`        | both      | groups requests and background jobs belonging to one user action                      |
| `Cache-Control: no-store` | response  | on health probes                                                                      |

Security headers (Helmet): `Content-Security-Policy: default-src 'none'` on API responses, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Referrer-Policy`, no `X-Powered-By`.

## Documentation

- OpenAPI 3.1 document: `GET /api/v1/openapi.json`
- Swagger UI: `GET /api/docs`

Both are enabled by default outside production (`API_DOCS_ENABLED`). Component schemas are generated from the same Zod schemas used for validation.
