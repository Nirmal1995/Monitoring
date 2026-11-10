import { ensureSessionIndexes } from '../modules/auth/sessions.service.ts';
import { EmailVerificationTokenModel, PasswordResetTokenModel } from '../modules/auth/tokens.ts';
import { UserModel } from '../modules/users/user.model.ts';

/**
 * Creates every index the application relies on (unique email, TTL indexes
 * for tokens, session lookups). Run automatically outside production; in
 * production it runs as a controlled migration step before deploying.
 */
export async function ensureIndexes(): Promise<void> {
  await Promise.all([
    UserModel.createIndexes(),
    EmailVerificationTokenModel.createIndexes(),
    PasswordResetTokenModel.createIndexes(),
    ensureSessionIndexes(),
  ]);
}
