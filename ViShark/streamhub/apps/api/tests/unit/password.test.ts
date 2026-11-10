import { describe, expect, it } from 'vitest';
import { createPasswordHasher } from '../../src/modules/auth/password.ts';

const params = { ARGON2_MEMORY_KIB: 19_456, ARGON2_TIME_COST: 2, ARGON2_PARALLELISM: 1 };

describe('password hasher', () => {
  const hasher = createPasswordHasher(params);

  it('produces an Argon2id hash with the configured parameters and a random salt', async () => {
    const a = await hasher.hash('correct horse battery staple');
    const b = await hasher.hash('correct horse battery staple');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(hash, 'correct horse battery stapl')).toBe(false);
  });

  it('returns false for a malformed stored hash instead of throwing', async () => {
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
  });

  it('flags hashes made with weaker parameters for rehashing', async () => {
    const stronger = createPasswordHasher({ ...params, ARGON2_TIME_COST: 3 });
    const old = await hasher.hash('pw-pw-pw-pw-pw');
    expect(stronger.needsRehash(old)).toBe(true);
    expect(hasher.needsRehash(old)).toBe(false);
  });

  it('spends comparable time on the dummy verification as on a real one', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    await hasher.verifyAgainstDummy('warm up'); // first call creates the dummy hash
    const time = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      for (let i = 0; i < 3; i++) await fn();
      return performance.now() - start;
    };
    const real = await time(() => hasher.verify(hash, 'wrong password'));
    const dummy = await time(() => hasher.verifyAgainstDummy('wrong password'));
    expect(dummy).toBeGreaterThan(real * 0.5);
    expect(dummy).toBeLessThan(real * 2);
  });
});
