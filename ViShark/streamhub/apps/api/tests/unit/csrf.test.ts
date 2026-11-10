import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/middleware/error-handler.ts';
import { csrfProtection } from '../../src/middleware/csrf.ts';
import { requestContext } from '../../src/middleware/request-context.ts';
import { silentLogger } from '../helpers.ts';

const TRUSTED = 'http://localhost:5273';

/** Minimal app with a fake session so the middleware can be tested in isolation. */
function appWith(session: Record<string, unknown> | undefined) {
  const app = express();
  app.use(requestContext);
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof silentLogger }).log = silentLogger;
    (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use(csrfProtection([TRUSTED]));
  app.all('/x', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

const authed = { userId: 'u1', csrfToken: 'token-abc-123' };

describe('csrfProtection', () => {
  it('lets safe methods through without checks', async () => {
    const res = await request(appWith(authed)).get('/x').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
  });

  it('blocks a state-changing request from an untrusted Origin', async () => {
    const res = await request(appWith(undefined)).post('/x').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('blocks a cross-site request identified only by Sec-Fetch-Site', async () => {
    const res = await request(appWith(undefined)).post('/x').set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(403);
  });

  it('allows an unauthenticated request from the trusted origin (login, register)', async () => {
    const res = await request(appWith(undefined)).post('/x').set('Origin', TRUSTED);
    expect(res.status).toBe(200);
  });

  it('allows non-browser clients without Origin when there is no session', async () => {
    expect((await request(appWith(undefined)).post('/x')).status).toBe(200);
  });

  it('requires the token for authenticated sessions, even from the trusted origin', async () => {
    const res = await request(appWith(authed)).post('/x').set('Origin', TRUSTED);
    expect(res.status).toBe(403);
  });

  it('requires the token for authenticated sessions from non-browser clients too', async () => {
    expect((await request(appWith(authed)).delete('/x')).status).toBe(403);
  });

  it('rejects a wrong token', async () => {
    const res = await request(appWith(authed))
      .post('/x')
      .set('Origin', TRUSTED)
      .set('X-CSRF-Token', 'token-abc-124');
    expect(res.status).toBe(403);
  });

  it('accepts the correct token', async () => {
    const res = await request(appWith(authed))
      .post('/x')
      .set('Origin', TRUSTED)
      .set('X-CSRF-Token', 'token-abc-123');
    expect(res.status).toBe(200);
  });
});
