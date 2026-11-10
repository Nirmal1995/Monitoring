import { readFileSync } from 'node:fs';
import { AppError } from '../../common/errors.ts';

/**
 * Server-side password checks beyond length (OWASP ASVS 2.1.7): reject
 * passwords found in public breach lists, and the user's own email.
 * The list ships with the app (no network call); see assets/common-passwords.txt.
 *
 * A production upgrade is the Have I Been Pwned k-anonymity API, which checks
 * against hundreds of millions of breached passwords while sending only the
 * first 5 characters of the password's SHA-1 hash.
 */
const COMMON = new Set(
  readFileSync(new URL('../../../assets/common-passwords.txt', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')),
);

export const weakPassword = (reason: string) =>
  new AppError(400, 'WEAK_PASSWORD', 'Choose a different password', [
    { path: 'password', message: reason },
  ]);

export function assertPasswordAcceptable(password: string, email: string): void {
  const normalized = password.trim().toLowerCase();
  if (COMMON.has(normalized))
    throw weakPassword('this password appears in lists of commonly used passwords');
  if (normalized === email.toLowerCase())
    throw weakPassword('the password must not be your email address');
}

export const commonPasswordCount = () => COMMON.size;
