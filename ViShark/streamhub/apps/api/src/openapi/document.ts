import {
  changePasswordBodySchema,
  deactivateAccountBodySchema,
  emailOnlyBodySchema,
  loginBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  sessionDtoSchema,
  updateProfileBodySchema,
  userDtoSchema,
  verifyEmailBodySchema,
} from '@streamhub/contracts';
import { z } from 'zod';

/**
 * OpenAPI 3.1 document. Component schemas are generated from the same Zod
 * schemas the API uses for validation (z.toJSONSchema), so documentation and
 * enforcement cannot drift apart. Each module adds its paths here.
 */
const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

const DependencyStatus = z.object({
  name: z.string().meta({ example: 'mongodb' }),
  status: z.enum(['up', 'down']),
  latencyMs: z.number().int(),
});

const ReadinessReport = z.object({
  status: z.enum(['ready', 'not_ready']),
  draining: z.boolean(),
  dependencies: z.array(DependencyStatus),
});

const ApiInfo = z.object({
  data: z.object({
    name: z.string(),
    version: z.string(),
    apiVersion: z.literal('v1'),
    docs: z.string().nullable(),
  }),
});

function schema(s: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(s, { target: 'draft-2020-12' });
  return rest;
}

const REQUEST_ID = '9a1c0f5e-6f7e-4a1b-9a53-2a6b8e3d2f10';

/** A documented error response with a realistic example for each status. */
function errorResponse(description: string, code: string, message: string, details?: unknown) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorBody' },
        example: {
          error: { code, message, requestId: REQUEST_ID, ...(details ? { details } : {}) },
        },
      },
    },
  };
}

const json = (name: string) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const dataOf = (inner: object) => ({
  'application/json': {
    schema: { type: 'object', properties: { data: inner }, required: ['data'] },
  },
});
const message = (example: string) =>
  dataOf({ type: 'object', properties: { message: { type: 'string', example } } });
const authenticated = [{ sessionCookie: [], csrfToken: [] }];
const sessionOnly = [{ sessionCookie: [] }];
const errors = (...statuses: string[]) =>
  Object.fromEntries(
    statuses.map((status) => [status, { $ref: `#/components/responses/E${status}` }]),
  );
const ACCEPTED = 'If an account exists for this email, we have sent instructions to it.';

export function buildOpenApiDocument(version: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'StreamHub API',
      version,
      description: [
        'REST API for StreamHub. Endpoints under /api/v1 return `{ data }` on success and `{ error }` on failure; every response carries `X-Request-Id`.',
        '',
        '**Trying authenticated endpoints here:** run `POST /api/v1/auth/login`, copy `csrfToken` from the response, click **Authorize** and paste it into `csrfToken`. The session cookie is sent by the browser automatically.',
      ].join('\n'),
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'health', description: 'Liveness and readiness probes' },
      { name: 'meta', description: 'API information' },
      {
        name: 'auth',
        description: 'Registration, login, sessions, email verification and passwords',
      },
      { name: 'users', description: 'The signed-in user' },
    ],
    paths: {
      '/health/live': {
        get: {
          tags: ['health'],
          summary: 'Liveness probe',
          description: 'Returns 200 while the process is running. Does not check dependencies.',
          responses: {
            '200': {
              description: 'Process is alive',
              content: { 'application/json': { example: { status: 'ok' } } },
            },
          },
        },
      },
      '/health/ready': {
        get: {
          tags: ['health'],
          summary: 'Readiness probe',
          description:
            'Checks MongoDB and Redis. Returns 503 if any is down or the instance is shutting down.',
          responses: {
            '200': { description: 'Ready to receive traffic', content: json('ReadinessReport') },
            '503': { description: 'Not ready', content: json('ReadinessReport') },
          },
        },
      },
      '/api/v1': {
        get: {
          tags: ['meta'],
          summary: 'API information',
          responses: { '200': { description: 'API name and version', content: json('ApiInfo') } },
        },
      },
      '/api/v1/auth/session': {
        get: {
          tags: ['auth'],
          summary: 'Current session',
          description:
            'Returns `authenticated: false`, or the user and the CSRF token for this session.',
          responses: { '200': { description: 'Session state' } },
        },
      },
      '/api/v1/auth/register': {
        post: {
          tags: ['auth'],
          summary: 'Register',
          description:
            'Always 202 with the same body, whether or not the email is already registered (no account enumeration). New accounts receive a verification email; an existing owner receives a notice instead.',
          requestBody: { required: true, content: json('RegisterBody') },
          responses: {
            '202': {
              description: 'Accepted',
              content: message(
                'If this email can be registered, you will receive a verification email shortly.',
              ),
            },
            ...errors('400', '403', '429', '503'),
          },
        },
      },
      '/api/v1/auth/verify-email': {
        post: {
          tags: ['auth'],
          summary: 'Verify email address',
          description:
            'Consumes the single-use token from the verification email (the part after `#token=`).',
          requestBody: { required: true, content: json('VerifyEmailBody') },
          responses: {
            '200': {
              description: 'Verified',
              content: dataOf({ type: 'object', properties: { verified: { const: true } } }),
            },
            '400': errorResponse(
              'Invalid or expired token',
              'INVALID_TOKEN',
              'This link is invalid or has expired. Please request a new one.',
            ),
          },
        },
      },
      '/api/v1/auth/resend-verification': {
        post: {
          tags: ['auth'],
          summary: 'Resend the verification email',
          description: 'Always 202 with the same body. At most a few emails per address per hour.',
          requestBody: { required: true, content: json('EmailOnlyBody') },
          responses: {
            '202': { description: 'Accepted', content: message(ACCEPTED) },
            ...errors('400', '429'),
          },
        },
      },
      '/api/v1/auth/forgot-password': {
        post: {
          tags: ['auth'],
          summary: 'Request a password reset email',
          description:
            'Always 202 with the same body and timing, whether or not the account exists.',
          requestBody: { required: true, content: json('EmailOnlyBody') },
          responses: {
            '202': { description: 'Accepted', content: message(ACCEPTED) },
            ...errors('400', '429'),
          },
        },
      },
      '/api/v1/auth/reset-password': {
        post: {
          tags: ['auth'],
          summary: 'Set a new password with a reset token',
          description: 'Single-use token from the email. Signs out every session of the account.',
          requestBody: { required: true, content: json('ResetPasswordBody') },
          responses: {
            '200': {
              description: 'Password changed',
              content: message('Your password has been changed. Please sign in.'),
            },
            '400': errorResponse(
              'Invalid token or weak password',
              'INVALID_TOKEN',
              'This link is invalid or has expired. Please request a new one.',
            ),
          },
        },
      },
      '/api/v1/auth/login': {
        post: {
          tags: ['auth'],
          summary: 'Log in',
          description:
            'Starts a new session (new session ID) and returns the CSRF token to send as `X-CSRF-Token` on later state-changing requests. Unknown email and wrong password give the same 401. Throttled per IP and per email.',
          requestBody: { required: true, content: json('LoginBody') },
          responses: {
            '200': {
              description: 'Signed in; session cookie set',
              content: dataOf({
                type: 'object',
                properties: { user: ref('UserDto'), csrfToken: { type: 'string' } },
              }),
            },
            '401': errorResponse(
              'Wrong email or password',
              'INVALID_CREDENTIALS',
              'Invalid email or password',
            ),
            '403': errorResponse(
              'Unverified or deactivated account',
              'EMAIL_NOT_VERIFIED',
              'Please verify your email address before signing in',
            ),
            ...errors('400', '429', '503'),
          },
        },
      },
      '/api/v1/auth/change-password': {
        post: {
          tags: ['auth'],
          summary: 'Change my password',
          description:
            'Requires the current password. Signs out other devices and starts a new session here: use the new `csrfToken` from the response.',
          security: authenticated,
          requestBody: { required: true, content: json('ChangePasswordBody') },
          responses: {
            '200': {
              description: 'Changed',
              content: dataOf({ type: 'object', properties: { csrfToken: { type: 'string' } } }),
            },
            '400': errorResponse(
              'Current password wrong or new password weak',
              'INVALID_CURRENT_PASSWORD',
              'The current password is incorrect',
            ),
            ...errors('401', '403'),
          },
        },
      },
      '/api/v1/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'Log out',
          security: authenticated,
          responses: { '204': { description: 'Session destroyed' }, ...errors('403') },
        },
      },
      '/api/v1/auth/sessions': {
        get: {
          tags: ['auth'],
          summary: 'List my sessions',
          security: sessionOnly,
          responses: {
            '200': {
              description: 'Sessions',
              content: dataOf({ type: 'array', items: ref('SessionDto') }),
            },
            ...errors('401'),
          },
        },
        delete: {
          tags: ['auth'],
          summary: 'Sign out all other devices',
          security: authenticated,
          responses: {
            '200': {
              description: 'Number of sessions revoked',
              content: dataOf({
                type: 'object',
                properties: { revoked: { type: 'integer', example: 2 } },
              }),
            },
            ...errors('401', '403'),
          },
        },
      },
      '/api/v1/auth/sessions/{handle}': {
        delete: {
          tags: ['auth'],
          summary: 'Revoke one of my sessions',
          security: authenticated,
          parameters: [
            {
              name: 'handle',
              in: 'path',
              required: true,
              schema: { type: 'string', example: 'Wg3NZ3rsEHhWp3qUWHuiTA' },
            },
          ],
          responses: { '204': { description: 'Revoked' }, ...errors('400', '401', '403', '404') },
        },
      },
      '/api/v1/users/me': {
        get: {
          tags: ['users'],
          summary: 'My profile',
          security: sessionOnly,
          responses: {
            '200': { description: 'Profile', content: dataOf(ref('UserDto')) },
            ...errors('401'),
          },
        },
        patch: {
          tags: ['users'],
          summary: 'Update my profile',
          security: authenticated,
          requestBody: { required: true, content: json('UpdateProfileBody') },
          responses: {
            '200': { description: 'Updated profile', content: dataOf(ref('UserDto')) },
            ...errors('400', '401', '403'),
          },
        },
      },
      '/api/v1/users/me/deactivate': {
        post: {
          tags: ['users'],
          summary: 'Deactivate my account',
          description:
            'Requires the password. Signs out every session; the account can no longer log in.',
          security: authenticated,
          requestBody: { required: true, content: json('DeactivateAccountBody') },
          responses: {
            '204': { description: 'Deactivated' },
            '400': errorResponse(
              'Wrong password',
              'INVALID_CURRENT_PASSWORD',
              'The password is incorrect',
            ),
            ...errors('401', '403'),
          },
        },
      },
    },
    components: {
      schemas: {
        ErrorBody: schema(ErrorBody),
        ReadinessReport: schema(ReadinessReport),
        ApiInfo: schema(ApiInfo),
        RegisterBody: schema(registerBodySchema),
        LoginBody: schema(loginBodySchema),
        VerifyEmailBody: schema(verifyEmailBodySchema),
        EmailOnlyBody: schema(emailOnlyBodySchema),
        ResetPasswordBody: schema(resetPasswordBodySchema),
        ChangePasswordBody: schema(changePasswordBodySchema),
        DeactivateAccountBody: schema(deactivateAccountBodySchema),
        UpdateProfileBody: schema(updateProfileBodySchema),
        UserDto: schema(userDtoSchema),
        SessionDto: schema(sessionDtoSchema),
      },
      responses: {
        E400: errorResponse('Validation failed', 'BAD_REQUEST', 'Request validation failed', [
          { location: 'body', path: 'password', message: 'must be at least 12 characters' },
        ]),
        E401: errorResponse(
          'Not signed in, or the session expired',
          'UNAUTHENTICATED',
          'Authentication required',
        ),
        E403: errorResponse(
          'Forbidden or CSRF check failed',
          'CSRF_FAILED',
          'Missing or invalid CSRF token',
        ),
        E404: errorResponse('Not found', 'NOT_FOUND', 'Session not found'),
        E429: errorResponse(
          'Too many requests (see Retry-After)',
          'TOO_MANY_REQUESTS',
          'Too many requests, please try again later',
        ),
        E500: errorResponse(
          'Unexpected server error',
          'INTERNAL_ERROR',
          'An unexpected error occurred',
        ),
        E503: errorResponse(
          'A dependency is unavailable',
          'SERVICE_UNAVAILABLE',
          'Service temporarily unavailable, please retry shortly',
        ),
      },
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'streamhub.sid' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
      },
    },
  };
}
