import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Router } from 'express';
import type { Redis } from 'ioredis';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config/env.ts';
import { createRedis } from '../../src/infrastructure/redis.ts';
import { createAuthModule } from '../../src/modules/auth/index.ts';
import { createPasswordHasher } from '../../src/modules/auth/password.ts';
import type { SessionPolicy } from '../../src/modules/auth/session.ts';
import { ensureSessionIndexes } from '../../src/modules/auth/sessions.service.ts';
import { HealthService } from '../../src/modules/health/health.service.ts';
import { UserModel } from '../../src/modules/users/user.model.ts';
import { silentLogger } from '../helpers.ts';

/**
 * Integration tests run against the real local MongoDB and Redis, but in
 * separate namespaces: database "<name>_test" and Redis logical DB 15. They
 * never read or modify development data.
 */
const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function testMongoUrl(url: string): string {
  const parsed = new URL(url);
  const db = parsed.pathname.replace(/^\//, '') || 'streamhub';
  parsed.pathname = `/${db}_test`;
  return parsed.toString();
}

function testRedisUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/15';
  return parsed.toString();
}

export const ORIGIN = 'http://localhost:5273';
export const PASSWORD = 'correct horse battery staple';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  const base = loadConfig({ ...process.env, SESSION_SECRET: 'x'.repeat(48) });
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    MONGO_URL: testMongoUrl(base.MONGO_URL),
    REDIS_URL: testRedisUrl(base.REDIS_URL),
    SESSION_SECRET: 'integration-test-session-secret-0123456789abcdef',
    WEB_ORIGIN: ORIGIN,
    CSRF_EXTRA_TRUSTED_ORIGINS: '',
    AUTH_IP_LIMIT: '1000',
    AUTH_ACCOUNT_FAILURE_LIMIT: '1000',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

let redis: Redis | undefined;

/** Connects once per test file and empties the test namespaces. */
export async function connectTestInfra(config = testConfig()): Promise<Redis> {
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected) {
    await mongoose.connect(config.MONGO_URL, { serverSelectionTimeoutMS: 3000 });
  }
  redis ??= createRedis(config.REDIS_URL, silentLogger);
  await resetTestData();
  return redis;
}

export async function resetTestData(): Promise<void> {
  // The app user has readWrite only (no dbAdmin), so it cannot drop the
  // database; emptying collections keeps their indexes, which is what we want.
  const db = mongoose.connection.db;
  if (!db) throw new Error('not connected');
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (!name.startsWith('system.')) await db.collection(name).deleteMany({});
  }
  await UserModel.init();
  await ensureSessionIndexes();
  await redis?.flushdb();
}

export async function disconnectTestInfra(): Promise<void> {
  redis?.disconnect();
  redis = undefined;
  await mongoose.disconnect();
}

export function buildAuthApp(options: {
  redis: Redis;
  config?: AppConfig;
  policy?: SessionPolicy;
  extraRoutes?: { path: string; router: Router }[];
}) {
  const config = options.config ?? testConfig();
  const auth = createAuthModule({
    config,
    logger: silentLogger,
    redis: options.redis,
    mongoClientPromise: Promise.resolve(mongoose.connection.getClient()),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  auth.routes.push(...(options.extraRoutes ?? []));
  return createApp({
    config: { ...config, API_DOCS_ENABLED: false },
    logger: silentLogger,
    health: new HealthService([], silentLogger),
    auth,
    version: 'test',
  });
}

export async function createUser(
  overrides: Partial<{
    email: string;
    role: 'USER' | 'ADMIN';
    verified: boolean;
    status: 'ACTIVE' | 'DEACTIVATED';
  }> = {},
  config = testConfig(),
) {
  const hasher = createPasswordHasher(config);
  return UserModel.create({
    email: overrides.email ?? 'user@example.com',
    passwordHash: await hasher.hash(PASSWORD),
    displayName: 'Test User',
    role: overrides.role ?? 'USER',
    status: overrides.status ?? 'ACTIVE',
    emailVerifiedAt: overrides.verified === false ? null : new Date(),
  });
}

/** Logs in with a cookie-keeping agent and returns it with the CSRF token. */
export async function login(app: ReturnType<typeof buildAuthApp>, email = 'user@example.com') {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ email, password: PASSWORD });
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    agent,
    csrfToken: res.body.data.csrfToken as string,
    cookies: res.headers['set-cookie'] as unknown as string[],
  };
}

export function sessionIdFromCookies(cookies: string[]): string {
  const raw = cookies.find((c) => c.startsWith('streamhub.sid='));
  if (!raw) throw new Error('no session cookie');
  const value = decodeURIComponent(raw.split(';')[0]!.split('=')[1]!);
  // Signed cookie format: "s:<sessionId>.<signature>"
  return value.slice(2, value.lastIndexOf('.'));
}
