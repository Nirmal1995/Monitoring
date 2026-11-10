import {
  loginBodySchema,
  registerBodySchema,
  sessionDtoSchema,
  updateProfileBodySchema,
  userDtoSchema,
} from '@streamhub/contracts';
import { z } from 'zod';

/**
 * OpenAPI 3.1 document. Component schemas are generated from Zod schemas
 * (z.toJSONSchema), so documentation and validation share one definition.
 * Each module adds its paths here as it is built.
 */
const ErrorBody = z.object({
  error: z.object({
    code: z.string().meta({ example: 'NOT_FOUND' }),
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

const schema = (s: z.ZodType) => z.toJSONSchema(s, { target: 'draft-2020-12' });

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
});

const json = (ref: string) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${ref}` } },
});
const dataOf = (schemaRef: object) => ({
  'application/json': {
    schema: { type: 'object', properties: { data: schemaRef }, required: ['data'] },
  },
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const authenticated = [{ sessionCookie: [], csrfToken: [] }];
const sessionOnly = [{ sessionCookie: [] }];
const errors = (...codes: string[]) =>
  Object.fromEntries(codes.map((code) => [code, { $ref: `#/components/responses/E${code}` }]));

export function buildOpenApiDocument(version: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'StreamHub API',
      version,
      description:
        'REST API for StreamHub. All endpoints under /api/v1 return `{ data }` on success and `{ error }` on failure. Every response carries `X-Request-Id`.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'health', description: 'Liveness and readiness probes' },
      { name: 'meta', description: 'API information' },
      { name: 'auth', description: 'Registration, login and session management' },
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
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { const: 'ok' } },
                    required: ['status'],
                  },
                },
              },
            },
          },
        },
      },
      '/health/ready': {
        get: {
          tags: ['health'],
          summary: 'Readiness probe',
          description:
            'Checks the dependencies required to serve traffic. Returns 503 if any is down or the instance is shutting down.',
          responses: {
            '200': {
              description: 'Ready to receive traffic',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ReadinessReport' } },
              },
            },
            '503': {
              description: 'Not ready',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ReadinessReport' } },
              },
            },
          },
        },
      },
      '/api/v1': {
        get: {
          tags: ['meta'],
          summary: 'API information',
          responses: {
            '200': {
              description: 'API name and version',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiInfo' } } },
            },
          },
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
            'Always answers 202 with the same body, whether or not the email is already registered (prevents account enumeration). Rate limited per IP.',
          requestBody: { required: true, content: json('RegisterBody') },
          responses: { '202': { description: 'Accepted' }, ...errors('400', '403', '429', '503') },
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
            ...errors('400', '401', '403', '429', '503'),
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
            '200': { description: 'Number of sessions revoked' },
            ...errors('401', '403'),
          },
        },
      },
      '/api/v1/auth/sessions/{handle}': {
        delete: {
          tags: ['auth'],
          summary: 'Revoke one of my sessions',
          security: authenticated,
          parameters: [{ name: 'handle', in: 'path', required: true, schema: { type: 'string' } }],
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
    },
    components: {
      schemas: {
        ErrorBody: schema(ErrorBody),
        ReadinessReport: schema(ReadinessReport),
        ApiInfo: schema(ApiInfo),
        RegisterBody: schema(registerBodySchema),
        LoginBody: schema(loginBodySchema),
        UpdateProfileBody: schema(updateProfileBodySchema),
        UserDto: schema(userDtoSchema),
        SessionDto: schema(sessionDtoSchema),
      },
      responses: {
        E400: errorResponse('Validation failed'),
        E401: errorResponse('Not signed in, invalid credentials or session expired'),
        E403: errorResponse('Forbidden, CSRF check failed, unverified or deactivated account'),
        E404: errorResponse('Not found'),
        E429: errorResponse('Too many requests (see Retry-After)'),
        E500: errorResponse('Unexpected server error'),
        E503: errorResponse('A dependency is unavailable'),
      },
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'streamhub.sid' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
      },
    },
  };
}
