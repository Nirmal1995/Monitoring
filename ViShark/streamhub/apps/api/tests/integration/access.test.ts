import { Router } from 'express';
import type { Redis } from 'ioredis';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ok } from '../../src/common/http.ts';
import { requirePermission } from '../../src/middleware/authenticate.ts';
import { UserModel } from '../../src/modules/users/user.model.ts';
import {
  ORIGIN,
  buildAuthApp,
  connectTestInfra,
  createUser,
  disconnectTestInfra,
  login,
  resetTestData,
  sessionIdFromCookies,
} from './setup.ts';

let redis: Redis;
let app: ReturnType<typeof buildAuthApp>;

// Stand-in for real admin endpoints (built in Phase 4), protected exactly as they will be.
const adminRouter = Router().get('/', requirePermission('user:manage'), (_req, res) => {
  res.json(ok({ secret: 'admin-only' }));
});

beforeAll(async () => {
  redis = await connectTestInfra();
  app = buildAuthApp({ redis, extraRoutes: [{ path: '/test-admin', router: adminRouter }] });
});
beforeEach(resetTestData);
afterAll(disconnectTestInfra);

describe('role-based access control (server-side)', () => {
  it('rejects anonymous requests with 401', async () => {
    expect((await request(app).get('/api/v1/test-admin')).status).toBe(401);
    expect((await request(app).get('/api/v1/users/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/sessions')).status).toBe(401);
  });

  it('rejects a USER on an admin endpoint with 403', async () => {
    await createUser();
    const { agent } = await login(app);
    const res = await agent.get('/api/v1/test-admin');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows an ADMIN', async () => {
    await createUser({ email: 'admin@example.com', role: 'ADMIN' });
    const { agent } = await login(app, 'admin@example.com');
    expect((await agent.get('/api/v1/test-admin')).status).toBe(200);
  });

  it('applies a role change on the very next request (no stale role in the session)', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'ADMIN' });
    const { agent } = await login(app, 'admin@example.com');
    expect((await agent.get('/api/v1/test-admin')).status).toBe(200);
    await UserModel.updateOne({ _id: admin._id }, { $set: { role: 'USER' } });
    expect((await agent.get('/api/v1/test-admin')).status).toBe(403);
  });

  it('ends the session of a deactivated account immediately', async () => {
    const user = await createUser();
    const { agent } = await login(app);
    await UserModel.updateOne({ _id: user._id }, { $set: { status: 'DEACTIVATED' } });
    expect((await agent.get('/api/v1/users/me')).status).toBe(401);
  });
});

describe('profile (/users/me)', () => {
  it('returns only the signed-in user, without internal fields', async () => {
    await createUser();
    const { agent } = await login(app);
    const res = await agent.get('/api/v1/users/me');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual([
      'createdAt',
      'displayName',
      'email',
      'emailVerified',
      'id',
      'role',
    ]);
  });

  it('updates the display name', async () => {
    await createUser();
    const { agent, csrfToken } = await login(app);
    const res = await agent
      .patch('/api/v1/users/me')
      .set('X-CSRF-Token', csrfToken)
      .send({ displayName: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.data.displayName).toBe('Renamed');
  });

  it('cannot escalate privileges or change email through the profile (mass assignment)', async () => {
    await createUser();
    const { agent, csrfToken } = await login(app);
    for (const body of [
      { displayName: 'x', role: 'ADMIN' },
      { displayName: 'x', email: 'hijack@example.com' },
    ]) {
      const res = await agent.patch('/api/v1/users/me').set('X-CSRF-Token', csrfToken).send(body);
      expect(res.status).toBe(400);
    }
    const user = await UserModel.findOne({ email: 'user@example.com' }).lean();
    expect(user?.role).toBe('USER');
  });

  it('cannot modify another user: there is no user ID to tamper with', async () => {
    const victim = await createUser({ email: 'victim@example.com' });
    await createUser();
    const { agent, csrfToken } = await login(app);
    const res = await agent
      .patch(`/api/v1/users/${victim._id.toString()}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ displayName: 'pwned' });
    expect(res.status).toBe(404);
    expect((await UserModel.findById(victim._id).lean())?.displayName).toBe('Test User');
  });
});

describe('session management', () => {
  it('lists the user’s sessions with an opaque handle and never exposes session IDs', async () => {
    await createUser();
    const first = await login(app);
    await login(app);
    const res = await first.agent.get('/api/v1/auth/sessions');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(sessionIdFromCookies(first.cookies));
  });

  it('revokes another device by handle, which signs that device out', async () => {
    await createUser();
    const laptop = await login(app);
    const phone = await login(app);
    const list = await laptop.agent.get('/api/v1/auth/sessions');
    const phoneHandle = list.body.data.find((s: { current: boolean }) => !s.current)
      .handle as string;

    const res = await laptop.agent
      .delete(`/api/v1/auth/sessions/${phoneHandle}`)
      .set('X-CSRF-Token', laptop.csrfToken);
    expect(res.status).toBe(204);
    expect((await phone.agent.get('/api/v1/users/me')).status).toBe(401);
    expect((await laptop.agent.get('/api/v1/users/me')).status).toBe(200);
  });

  it('cannot revoke another user’s session (IDOR): same 404 as a non-existent handle', async () => {
    await createUser({ email: 'victim@example.com' });
    await createUser();
    const victim = await login(app, 'victim@example.com');
    const victimHandle = (await victim.agent.get('/api/v1/auth/sessions')).body.data[0]
      .handle as string;

    const attacker = await login(app);
    const res = await attacker.agent
      .delete(`/api/v1/auth/sessions/${victimHandle}`)
      .set('X-CSRF-Token', attacker.csrfToken);
    expect(res.status).toBe(404);
    const missing = await attacker.agent
      .delete(`/api/v1/auth/sessions/${'A'.repeat(22)}`)
      .set('X-CSRF-Token', attacker.csrfToken);
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe(res.body.error.message);
    expect((await victim.agent.get('/api/v1/users/me')).status).toBe(200);
  });

  it('signs out all other devices but keeps the current one', async () => {
    await createUser();
    const current = await login(app);
    const other1 = await login(app);
    const other2 = await login(app);
    const res = await current.agent
      .delete('/api/v1/auth/sessions')
      .set('X-CSRF-Token', current.csrfToken);
    expect(res.body.data).toEqual({ revoked: 2 });
    expect((await other1.agent.get('/api/v1/users/me')).status).toBe(401);
    expect((await other2.agent.get('/api/v1/users/me')).status).toBe(401);
    expect((await current.agent.get('/api/v1/users/me')).status).toBe(200);
  });

  it('rejects malformed handles before touching the database', async () => {
    await createUser();
    const { agent, csrfToken } = await login(app);
    const res = await agent
      .delete('/api/v1/auth/sessions/%7B%22%24ne%22%3A1%7D')
      .set('X-CSRF-Token', csrfToken);
    expect(res.status).toBe(400);
  });
});

describe('dependency failures', () => {
  it('returns 503 quickly when MongoDB is not connected', async () => {
    await mongoose.disconnect();
    try {
      const started = Date.now();
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'a@b.co', password: 'x' });
      expect(res.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await connectTestInfra();
    }
  });
});
