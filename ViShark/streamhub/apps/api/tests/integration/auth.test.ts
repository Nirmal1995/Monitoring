import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserModel } from '../../src/modules/users/user.model.ts';
import {
  ORIGIN,
  PASSWORD,
  buildAuthApp,
  connectTestInfra,
  createUser,
  disconnectTestInfra,
  login,
  resetTestData,
  sessionIdFromCookies,
  testConfig,
} from './setup.ts';

let redis: Redis;
let app: ReturnType<typeof buildAuthApp>;

beforeAll(async () => {
  redis = await connectTestInfra();
  app = buildAuthApp({ redis });
});
beforeEach(resetTestData);
afterAll(disconnectTestInfra);

describe('registration', () => {
  const body = { email: 'New.User@Example.com', password: PASSWORD, displayName: 'New User' };

  it('creates an unverified USER with an Argon2id hash and returns no account data', async () => {
    const res = await request(app).post('/api/v1/auth/register').set('Origin', ORIGIN).send(body);
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ message: expect.any(String) });

    const user = await UserModel.findOne({ email: 'new.user@example.com' })
      .select('+passwordHash')
      .lean();
    expect(user).toMatchObject({ role: 'USER', status: 'ACTIVE', emailVerifiedAt: null });
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(user)).not.toContain(PASSWORD);
  });

  it('answers a duplicate registration exactly like a new one (no account enumeration)', async () => {
    const first = await request(app).post('/api/v1/auth/register').set('Origin', ORIGIN).send(body);
    const second = await request(app)
      .post('/api/v1/auth/register')
      .set('Origin', ORIGIN)
      .send(body);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await UserModel.countDocuments()).toBe(1);
  });

  it('cannot self-assign a role (mass assignment)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({ ...body, role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it('enforces the password policy', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({ ...body, password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toMatchObject({ path: 'password' });
  });
});

describe('login', () => {
  it('signs in, sets a hardened session cookie and returns the user and CSRF token', async () => {
    await createUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'USER@example.com', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      email: 'user@example.com',
      role: 'USER',
      emailVerified: true,
    });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    expect(res.body.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers['cache-control']).toBe('no-store');

    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^streamhub\.sid=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
  });

  it('returns the same error for an unknown email and a wrong password', async () => {
    await createUser();
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'nobody@example.com', password: PASSWORD });
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'user@example.com', password: 'wrong password!!' });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const strip = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });
    expect(strip(unknown.body)).toEqual(strip(wrong.body));
    expect(unknown.headers['set-cookie']).toBeUndefined();
  });

  it('refuses unverified accounts, but only reveals that to someone with the password', async () => {
    await createUser({ verified: false });
    const ok = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(ok.status).toBe(403);
    expect(ok.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const guess = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'user@example.com', password: 'a wrong guess!!' });
    expect(guess.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses deactivated accounts', async () => {
    await createUser({ status: 'DEACTIVATED' });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('rejects NoSQL operator injection in credentials', async () => {
    await createUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: { $ne: null }, password: { $ne: null } });
    expect(res.status).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects login from a foreign origin (login CSRF)', async () => {
    await createUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('upgrades a hash made with weaker parameters on successful login', async () => {
    await createUser({}, testConfig({ ARGON2_TIME_COST: '2' }));
    const stronger = buildAuthApp({ redis, config: testConfig({ ARGON2_TIME_COST: '3' }) });
    const res = await request(stronger)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    const user = await UserModel.findOne({ email: 'user@example.com' })
      .select('+passwordHash')
      .lean();
    expect(user?.passwordHash).toMatch(/t=3/);
  });
});

describe('session security', () => {
  it('stores only a hash of the session ID in the database', async () => {
    await createUser();
    const { cookies } = await login(app);
    const sid = sessionIdFromCookies(cookies);
    const sessions = mongoose.connection.collection('sessions');
    expect(await sessions.countDocuments({ _id: sid as never })).toBe(0);
    expect(
      await sessions.countDocuments({
        _id: createHash('sha256').update(sid).digest('hex') as never,
      }),
    ).toBe(1);
  });

  it('issues a new session ID at login (session fixation)', async () => {
    await createUser();
    const planted = 'streamhub.sid=s%3Aattacker-chosen-id.signature';
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('Cookie', planted)
      .send({ email: 'user@example.com', password: PASSWORD });
    const sid = sessionIdFromCookies(res.headers['set-cookie'] as unknown as string[]);
    expect(sid).not.toBe('attacker-chosen-id');

    // Logging in again from an authenticated session also rotates the ID.
    // (Without the CSRF token that request is rejected: it is a state change.)
    const { agent, cookies, csrfToken } = await login(app);
    const first = sessionIdFromCookies(cookies);
    const noToken = await agent
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(noToken.status).toBe(403);
    const again = await agent
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(again.status).toBe(200);
    expect(sessionIdFromCookies(again.headers['set-cookie'] as unknown as string[])).not.toBe(
      first,
    );
    // The old session is gone from the store, not just replaced in the browser.
    const sessions = mongoose.connection.collection('sessions');
    expect(
      await sessions.countDocuments({
        _id: createHash('sha256').update(first).digest('hex') as never,
      }),
    ).toBe(0);
  });

  it('reports the session state', async () => {
    expect((await request(app).get('/api/v1/auth/session')).body.data).toEqual({
      authenticated: false,
    });
    await createUser();
    const { agent, csrfToken } = await login(app);
    const res = await agent.get('/api/v1/auth/session');
    expect(res.body.data).toMatchObject({
      authenticated: true,
      csrfToken,
      user: { email: 'user@example.com' },
    });
  });

  it('requires the CSRF token for state changes in an authenticated session', async () => {
    await createUser();
    const { agent, csrfToken } = await login(app);
    expect((await agent.post('/api/v1/auth/logout').set('Origin', ORIGIN)).status).toBe(403);
    expect(
      (
        await agent
          .post('/api/v1/auth/logout')
          .set('Origin', 'https://evil.example')
          .set('X-CSRF-Token', csrfToken)
      ).status,
    ).toBe(403);
    expect(
      (await agent.post('/api/v1/auth/logout').set('Origin', ORIGIN).set('X-CSRF-Token', csrfToken))
        .status,
    ).toBe(204);
  });

  it('logout destroys the server-side session, so a copied cookie stops working', async () => {
    await createUser();
    const { agent, csrfToken, cookies } = await login(app);
    const stolen = cookies[0]!.split(';')[0]!;
    await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', csrfToken);
    const replay = await request(app).get('/api/v1/users/me').set('Cookie', stolen);
    expect(replay.status).toBe(401);
    expect(await mongoose.connection.collection('sessions').countDocuments()).toBe(0);
  });

  it('expires a session after the idle timeout', async () => {
    await createUser();
    const short = buildAuthApp({
      redis,
      policy: { idleTimeoutMs: 1200, absoluteTimeoutMs: 60_000, touchIntervalMs: 300 },
    });
    const { agent } = await login(short);
    expect((await agent.get('/api/v1/users/me')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    const res = await agent.get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });

  it('expires a session after the absolute timeout even while it is in use', async () => {
    await createUser();
    const short = buildAuthApp({
      redis,
      policy: { idleTimeoutMs: 60_000, absoluteTimeoutMs: 1500, touchIntervalMs: 100 },
    });
    const { agent } = await login(short);
    for (let i = 0; i < 3; i++) {
      expect((await agent.get('/api/v1/users/me')).status).toBe(200);
      await new Promise((r) => setTimeout(r, 400));
    }
    await new Promise((r) => setTimeout(r, 500));
    const res = await agent.get('/api/v1/users/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });
});

describe('brute-force protection', () => {
  it('throttles an account after repeated failures, even if the next password is right', async () => {
    await createUser();
    const strict = buildAuthApp({ redis, config: testConfig({ AUTH_ACCOUNT_FAILURE_LIMIT: '3' }) });
    for (let i = 0; i < 3; i++) {
      const res = await request(strict)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: `wrong password ${i}` });
      expect(res.status).toBe(401);
    }
    const res = await request(strict)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(res.status).toBe(429);
  });

  it('throttles unknown emails the same way (throttling does not reveal accounts)', async () => {
    const strict = buildAuthApp({ redis, config: testConfig({ AUTH_ACCOUNT_FAILURE_LIMIT: '2' }) });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (
          await request(strict)
            .post('/api/v1/auth/login')
            .send({ email: 'ghost@example.com', password: 'whatever!!' })
        ).status,
      );
    }
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('limits login requests per client IP and says when to retry', async () => {
    const strict = buildAuthApp({
      redis,
      config: testConfig({ AUTH_IP_LIMIT: '2', AUTH_IP_WINDOW_SECONDS: '60' }),
    });
    const send = () =>
      request(strict).post('/api/v1/auth/login').send({ email: 'a@example.com', password: 'x' });
    expect((await send()).status).toBe(401);
    expect((await send()).status).toBe(401);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['ratelimit-policy']).toBe('2;w=60');
  });

  it('fails closed (503) when Redis is unreachable, instead of disabling protection', async () => {
    const { createRedis } = await import('../../src/infrastructure/redis.ts');
    const { silentLogger } = await import('../helpers.ts');
    const deadRedis = createRedis('redis://127.0.0.1:1/0', silentLogger);
    const broken = buildAuthApp({ redis: deadRedis });
    const res = await request(broken)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    deadRedis.disconnect();
  });
});
