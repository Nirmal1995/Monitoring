import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors.ts';
import {
  assertPasswordAcceptable,
  commonPasswordCount,
} from '../../src/modules/auth/password-policy.ts';

/** Returns the rejection reason, or null if the password is accepted. */
function reasonFor(password: string, email: string): string | null {
  try {
    assertPasswordAcceptable(password, email);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('WEAK_PASSWORD');
    return ((err as AppError).details as { message: string }[])[0]?.message ?? '';
  }
}

describe('assertPasswordAcceptable', () => {
  it('loads the bundled common-password list', () => {
    expect(commonPasswordCount()).toBeGreaterThan(1000);
  });

  it.each(['password1234', 'PASSWORD1234', '  password1234  ', '123456789012'])(
    'rejects common password %j',
    (pw) => {
      expect(reasonFor(pw, 'a@b.co')).toMatch(/commonly used/);
    },
  );

  it('rejects the email address as password, case-insensitively', () => {
    expect(reasonFor('Alice@Example.com', 'alice@example.com')).toMatch(/email/);
  });

  it('accepts a long uncommon passphrase', () => {
    expect(reasonFor('correct horse battery staple', 'a@b.co')).toBeNull();
  });
});
