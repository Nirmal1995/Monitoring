import { describe, expect, it } from 'vitest';
import { loginBodySchema, registerBodySchema, updateProfileBodySchema } from './auth.ts';

const valid = {
  email: 'Alice@Example.COM ',
  password: 'correct horse battery',
  displayName: 'Alice',
};

describe('registerBodySchema', () => {
  it('normalises the email (trim + lowercase)', () => {
    expect(registerBodySchema.parse(valid).email).toBe('alice@example.com');
  });

  it.each([
    ['short password', { ...valid, password: 'short-pw-11' }],
    ['overlong password', { ...valid, password: 'x'.repeat(129) }],
    ['invalid email', { ...valid, email: 'not-an-email' }],
    ['empty display name', { ...valid, displayName: '   ' }],
    ['control characters in display name', { ...valid, displayName: 'Al\u0000ice' }],
    ['bidi override in display name', { ...valid, displayName: 'evil‮txt.exe' }],
    ['extra field (mass assignment)', { ...valid, role: 'ADMIN' }],
    ['operator object as email', { ...valid, email: { $ne: null } }],
  ])('rejects %s', (_label, body) => {
    expect(registerBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts long passphrases with spaces and unicode', () => {
    expect(
      registerBodySchema.safeParse({ ...valid, password: 'çorrect hørse bättery stäple 🐎' })
        .success,
    ).toBe(true);
  });
});

describe('loginBodySchema', () => {
  it('does not apply the password length policy (old accounts, no hints)', () => {
    expect(loginBodySchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(true);
  });

  it('rejects operator injection in password', () => {
    expect(loginBodySchema.safeParse({ email: 'a@b.co', password: { $gt: '' } }).success).toBe(
      false,
    );
  });
});

describe('updateProfileBodySchema', () => {
  it('rejects attempts to change role or email', () => {
    expect(updateProfileBodySchema.safeParse({ displayName: 'x', role: 'ADMIN' }).success).toBe(
      false,
    );
    expect(updateProfileBodySchema.safeParse({ displayName: 'x', email: 'x@y.z' }).success).toBe(
      false,
    );
  });
});
