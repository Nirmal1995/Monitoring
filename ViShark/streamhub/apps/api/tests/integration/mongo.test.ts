import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMongoConnection } from '../../src/database/mongo.ts';
import { HealthService } from '../../src/modules/health/health.service.ts';
import { silentLogger } from '../helpers.ts';
import { testConfig } from './setup.ts';

// Runs against the real local MongoDB (pnpm infra:up), test database only.
describe('MongoDB connection (integration)', () => {
  const config = testConfig({ MONGO_SERVER_SELECTION_TIMEOUT_MS: '3000' });
  const mongo = createMongoConnection(config, silentLogger);
  const health = new HealthService([{ name: 'mongodb', check: () => mongo.ping() }], silentLogger);

  beforeAll(async () => {
    if (mongoose.connection.readyState !== mongoose.ConnectionStates.disconnected)
      await mongoose.disconnect();
    await mongo.connect();
  });

  afterAll(async () => {
    await mongo.disconnect();
  });

  it('readiness is "ready" with a live connection', async () => {
    await expect(health.readiness()).resolves.toMatchObject({
      status: 'ready',
      dependencies: [{ name: 'mongodb', status: 'up' }],
    });
  });

  it('readiness turns "not_ready" after disconnecting, then recovers', async () => {
    await mongo.disconnect();
    await expect(health.readiness()).resolves.toMatchObject({ status: 'not_ready' });
    await mongo.connect();
    await expect(health.readiness()).resolves.toMatchObject({ status: 'ready' });
  });

  it('fails fast with a wrong password instead of hanging', async () => {
    // Mongoose uses one global default connection, so close the good one first.
    await mongo.disconnect();
    const bad = createMongoConnection(
      { ...config, MONGO_URL: config.MONGO_URL.replace(/:[^:@/]+@/, ':wrong-password@') },
      silentLogger,
    );
    const started = Date.now();
    await expect(bad.connect()).rejects.toThrow(/auth/i);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
