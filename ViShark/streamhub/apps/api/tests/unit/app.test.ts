import type express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { badRequest } from '../../src/common/errors.ts';
import { validate } from '../../src/middleware/validate.ts';
import { buildTestApp } from '../helpers.ts';

describe('health endpoints', () => {
  it('GET /health/live is 200 even when a dependency is down', async () => {
    const { app } = buildTestApp({
      checks: [{ name: 'db', check: () => Promise.reject(new Error('down')) }],
    });
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /health/ready is 200 when dependencies are up', async () => {
    const { app } = buildTestApp({ checks: [{ name: 'db', check: async () => {} }] });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('GET /health/ready is 503 when a dependency is down', async () => {
    const { app } = buildTestApp({
      checks: [{ name: 'db', check: () => Promise.reject(new Error('down')) }],
    });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.dependencies).toEqual([
      expect.objectContaining({ name: 'db', status: 'down' }),
    ]);
  });

  it('GET /health/ready is 503 while draining', async () => {
    const { app, health } = buildTestApp({ checks: [{ name: 'db', check: async () => {} }] });
    health.startDraining();
    expect((await request(app).get('/health/ready')).status).toBe(503);
  });
});

describe('request IDs', () => {
  it('generates a request ID and echoes it in the response', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-correlation-id']).toBe(res.headers['x-request-id']);
  });

  it('keeps a well-formed incoming request and correlation ID', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .get('/api/v1')
      .set('X-Request-Id', 'edge-req-12345')
      .set('X-Correlation-Id', 'user-action-67890');
    expect(res.headers['x-request-id']).toBe('edge-req-12345');
    expect(res.headers['x-correlation-id']).toBe('user-action-67890');
  });

  it.each([
    ['too short', 'abc'],
    ['spaces', 'not allowed spaces'],
    ['header/log injection attempt', 'abc12345%0d%0aSet-Cookie:x=1'],
    ['too long', 'a'.repeat(200)],
  ])('replaces a malformed incoming ID (%s)', async (_label, value) => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1').set('X-Request-Id', value);
    expect(res.headers['x-request-id']).not.toBe(value);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('versioned API and docs', () => {
  it('GET /api/v1 returns API info in the success envelope', async () => {
    const res = await request(buildTestApp().app).get('/api/v1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { name: 'StreamHub API', version: '0.0.0-test', apiVersion: 'v1', docs: '/api/docs' },
    });
  });

  it('serves a valid OpenAPI 3.1 document listing the health endpoints', async () => {
    const res = await request(buildTestApp().app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/health/live', '/health/ready', '/api/v1']),
    );
    expect(res.body.components.schemas.ErrorBody.type).toBe('object');
  });

  it('serves Swagger UI when docs are enabled', async () => {
    const res = await request(buildTestApp().app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('does not expose docs when disabled', async () => {
    const { app } = buildTestApp({ docs: false });
    expect((await request(app).get('/api/docs/')).status).toBe(404);
    expect((await request(app).get('/api/v1/openapi.json')).status).toBe(404);
  });
});

describe('error handling', () => {
  const extraRoutes = (app: express.Express) => {
    app.get('/test/boom', () => {
      throw new Error('database password is hunter2 at /srv/app/secret.ts:42');
    });
    app.get('/test/async-boom', async () => {
      await Promise.resolve();
      throw new Error('async failure with internals');
    });
    app.get('/test/known', () => {
      throw badRequest('Title is required');
    });
    app.post(
      '/test/validate',
      validate({ body: z.strictObject({ title: z.string().min(1) }) }),
      (_req, res) => {
        res.json({ data: res.locals.validated });
      },
    );
    app.post('/test/echo', (req, res) => {
      res.json({ data: req.body as unknown });
    });
  };

  it('returns 404 in the error envelope for unknown routes', async () => {
    const res = await request(buildTestApp().app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: 'NOT_FOUND',
      message: 'Route not found',
      requestId: res.headers['x-request-id'],
    });
  });

  it.each(['/test/boom', '/test/async-boom'])(
    'hides internals of unexpected errors (%s)',
    async (path) => {
      const res = await request(buildTestApp({ extraRoutes }).app).get(path);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.message).toBe('An unexpected error occurred');
      expect(res.text).not.toMatch(/hunter2|secret\.ts|internals|at \//);
    },
  );

  it('passes through intentional application errors', async () => {
    const res = await request(buildTestApp({ extraRoutes }).app).get('/test/known');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Title is required' });
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(buildTestApp({ extraRoutes }).app)
      .post('/test/echo')
      .set('Content-Type', 'application/json')
      .send('{"title": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects bodies over the size limit with 413', async () => {
    const res = await request(buildTestApp({ extraRoutes }).app)
      .post('/test/echo')
      .send({ title: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('validation reports each failing field', async () => {
    const res = await request(buildTestApp({ extraRoutes }).app)
      .post('/test/validate')
      .send({ title: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ location: 'body', path: 'title' }),
    ]);
  });

  it('validation rejects unknown fields (mass assignment)', async () => {
    const res = await request(buildTestApp({ extraRoutes }).app)
      .post('/test/validate')
      .send({ title: 'ok', role: 'ADMIN' });
    expect(res.status).toBe(400);
  });

  it('validation rejects NoSQL operator objects where a string is expected', async () => {
    const res = await request(buildTestApp({ extraRoutes }).app)
      .post('/test/validate')
      .send({ title: { $ne: null } });
    expect(res.status).toBe(400);
  });
});

describe('security headers', () => {
  it('sets strict headers and hides the framework', async () => {
    const res = await request(buildTestApp().app).get('/api/v1');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});
