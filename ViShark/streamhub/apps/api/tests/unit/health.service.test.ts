import { describe, expect, it, vi } from 'vitest';
import { HealthService } from '../../src/modules/health/health.service.ts';
import { silentLogger } from '../helpers.ts';

describe('HealthService.readiness', () => {
  it('is ready when every dependency is up', async () => {
    const health = new HealthService([{ name: 'db', check: async () => {} }], silentLogger);
    await expect(health.readiness()).resolves.toMatchObject({
      status: 'ready',
      dependencies: [{ name: 'db', status: 'up' }],
    });
  });

  it('is not ready when a dependency fails, and does not leak the error', async () => {
    const health = new HealthService(
      [
        { name: 'db', check: async () => {} },
        { name: 'cache', check: () => Promise.reject(new Error('password=hunter2 refused')) },
      ],
      silentLogger,
    );
    const report = await health.readiness();
    expect(report.status).toBe('not_ready');
    expect(report.dependencies).toEqual([
      expect.objectContaining({ name: 'db', status: 'up' }),
      expect.objectContaining({ name: 'cache', status: 'down' }),
    ]);
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });

  it('treats a hanging check as down after the timeout', async () => {
    vi.useFakeTimers();
    const health = new HealthService(
      [{ name: 'slow', check: () => new Promise(() => {}) }],
      silentLogger,
    );
    const pending = health.readiness();
    await vi.advanceTimersByTimeAsync(2001);
    await expect(pending).resolves.toMatchObject({ status: 'not_ready' });
    vi.useRealTimers();
  });

  it('reports not ready while draining even if dependencies are up', async () => {
    const health = new HealthService([{ name: 'db', check: async () => {} }], silentLogger);
    health.startDraining();
    await expect(health.readiness()).resolves.toMatchObject({
      status: 'not_ready',
      draining: true,
    });
  });
});
