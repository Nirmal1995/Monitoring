import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { sessionPolicyFromConfig, sessionTimeouts } from '../../src/modules/auth/session.ts';

const policy = {
  idleTimeoutMs: 30 * 60_000,
  absoluteTimeoutMs: 12 * 3_600_000,
  touchIntervalMs: 60_000,
};

function run(session: Record<string, unknown>) {
  let destroyed = false;
  let error: unknown;
  const req = {
    session: Object.assign(session, {
      destroy: (cb: () => void) => {
        destroyed = true;
        cb();
      },
    }),
  } as unknown as Request;
  sessionTimeouts(policy)(
    req,
    {} as Response,
    ((err?: unknown) => {
      error = err;
    }) as NextFunction,
  );
  return { destroyed, error: error as { code?: string } | undefined, session };
}

describe('sessionTimeouts', () => {
  const now = Date.now();

  it('ignores anonymous sessions', () => {
    expect(run({}).destroyed).toBe(false);
  });

  it('keeps an active session and refreshes lastSeenAt after the touch interval', () => {
    const r = run({ userId: 'u', createdAt: now - 3_600_000, lastSeenAt: now - 120_000 });
    expect(r.destroyed).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.session.lastSeenAt as number).toBeGreaterThanOrEqual(now);
  });

  it('does not rewrite lastSeenAt on every request', () => {
    const lastSeenAt = now - 10_000;
    expect(run({ userId: 'u', createdAt: now, lastSeenAt }).session.lastSeenAt).toBe(lastSeenAt);
  });

  it('expires a session idle for longer than the idle timeout', () => {
    const r = run({ userId: 'u', createdAt: now - 3_600_000, lastSeenAt: now - 31 * 60_000 });
    expect(r.destroyed).toBe(true);
    expect(r.error?.code).toBe('SESSION_EXPIRED');
  });

  it('expires a session older than the absolute timeout even if active', () => {
    const r = run({ userId: 'u', createdAt: now - 13 * 3_600_000, lastSeenAt: now - 1000 });
    expect(r.destroyed).toBe(true);
    expect(r.error?.code).toBe('SESSION_EXPIRED');
  });

  it('treats a session without timestamps as expired', () => {
    expect(run({ userId: 'u' }).destroyed).toBe(true);
  });
});

describe('sessionPolicyFromConfig', () => {
  it('derives a touch interval that never exceeds a quarter of the idle timeout', () => {
    expect(
      sessionPolicyFromConfig({
        SESSION_IDLE_TIMEOUT_MINUTES: 30,
        SESSION_ABSOLUTE_TIMEOUT_HOURS: 12,
      }),
    ).toEqual({ idleTimeoutMs: 1_800_000, absoluteTimeoutMs: 43_200_000, touchIntervalMs: 60_000 });
    expect(
      sessionPolicyFromConfig({
        SESSION_IDLE_TIMEOUT_MINUTES: 1,
        SESSION_ABSOLUTE_TIMEOUT_HOURS: 1,
      }).touchIntervalMs,
    ).toBe(15_000);
  });
});
