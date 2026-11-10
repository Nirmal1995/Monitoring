import argon2 from 'argon2';
import type { AppConfig } from '../../config/env.ts';

/**
 * Argon2id password hashing.
 *
 * Argon2id is memory-hard: each guess needs (here) 19 MiB of RAM, which makes
 * GPU and ASIC cracking far more expensive than with fast hashes (SHA-256) or
 * older adaptive ones (bcrypt is CPU-hard only). The salt is random per hash
 * and stored inside the encoded string together with the parameters, so
 * parameters can be raised later and old hashes still verify; needsRehash()
 * tells us when to upgrade a hash on the user's next successful login.
 */
export type PasswordHasher = {
  hash: (password: string) => Promise<string>;
  verify: (hash: string, password: string) => Promise<boolean>;
  needsRehash: (hash: string) => boolean;
  /** Burns the same CPU/RAM as a real verification (used for unknown emails). */
  verifyAgainstDummy: (password: string) => Promise<false>;
};

export function createPasswordHasher(
  config: Pick<AppConfig, 'ARGON2_MEMORY_KIB' | 'ARGON2_TIME_COST' | 'ARGON2_PARALLELISM'>,
): PasswordHasher {
  const options = {
    type: argon2.argon2id,
    memoryCost: config.ARGON2_MEMORY_KIB,
    timeCost: config.ARGON2_TIME_COST,
    parallelism: config.ARGON2_PARALLELISM,
  } as const;

  // Created lazily once; verifying against it costs the same as a real check.
  let dummyHash: Promise<string> | undefined;

  return {
    hash: (password) => argon2.hash(password, options),
    verify: async (hash, password) => {
      try {
        return await argon2.verify(hash, password);
      } catch {
        // Malformed hash in the database: treat as a failed login, never crash.
        return false;
      }
    },
    needsRehash: (hash) => argon2.needsRehash(hash, options),
    verifyAgainstDummy: async (password) => {
      dummyHash ??= argon2.hash('dummy-password-for-timing-equalisation', options);
      await argon2.verify(await dummyHash, password).catch(() => false);
      return false;
    },
  };
}
