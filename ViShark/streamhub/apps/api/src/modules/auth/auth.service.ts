import { createHash } from 'node:crypto';
import type { LoginBody, RegisterBody } from '@streamhub/contracts';
import type { Logger } from 'pino';
import { AppError } from '../../common/errors.ts';
import { UserModel, type UserDocument } from '../users/user.model.ts';
import type { LoginThrottle } from './login-throttle.ts';
import type { PasswordHasher } from './password.ts';

export const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

/** Stable, non-reversible identifier for an email in logs (emails are personal data). */
export const emailFingerprint = (email: string) =>
  createHash('sha256').update(email).digest('hex').slice(0, 16);

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

export type AuthService = ReturnType<typeof createAuthService>;

export function createAuthService(deps: {
  hasher: PasswordHasher;
  throttle: LoginThrottle;
  logger: Logger;
  requireEmailVerification: boolean;
}) {
  const { hasher, throttle } = deps;
  const log = deps.logger.child({ component: 'auth' });

  return {
    /**
     * Creates an account. The response is identical whether or not the email
     * is already registered, so registration cannot be used to test which
     * emails have accounts. (Phase 3b emails the existing owner instead.)
     */
    async register(input: RegisterBody): Promise<void> {
      // Hash first, even for duplicates, so both paths take the same time.
      const passwordHash = await hasher.hash(input.password);
      try {
        const user = await UserModel.create({
          email: input.email,
          passwordHash,
          displayName: input.displayName,
        });
        log.info({ event: 'auth.register', userId: user._id.toString() }, 'account created');
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        log.info(
          { event: 'auth.register.duplicate', email: emailFingerprint(input.email) },
          'email already registered',
        );
      }
    },

    /**
     * Verifies credentials. Unknown email and wrong password produce the same
     * error after the same amount of work (a dummy Argon2 verification), so
     * neither the message nor the response time reveals whether an account exists.
     */
    async login(input: LoginBody): Promise<UserDocument> {
      await throttle.assertAllowed(input.email);

      const user = await UserModel.findOne({ email: input.email }).select('+passwordHash').exec();
      const valid = user
        ? await hasher.verify(user.passwordHash, input.password)
        : await hasher.verifyAgainstDummy(input.password);

      if (!user || !valid) {
        await throttle.recordFailure(input.email);
        log.warn(
          { event: 'auth.login.failed', email: emailFingerprint(input.email) },
          'login failed',
        );
        throw invalidCredentials();
      }

      await throttle.reset(input.email);

      // Only reachable with the correct password, so these do not leak
      // account existence to an attacker who is guessing.
      if (user.status !== 'ACTIVE') {
        log.warn(
          { event: 'auth.login.blocked', reason: 'deactivated', userId: user._id.toString() },
          'login blocked',
        );
        throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
      }
      if (deps.requireEmailVerification && !user.emailVerifiedAt) {
        log.info(
          { event: 'auth.login.blocked', reason: 'unverified', userId: user._id.toString() },
          'login blocked',
        );
        throw new AppError(
          403,
          'EMAIL_NOT_VERIFIED',
          'Please verify your email address before signing in',
        );
      }

      if (hasher.needsRehash(user.passwordHash)) {
        user.passwordHash = await hasher.hash(input.password);
        log.info(
          { event: 'auth.password.rehashed', userId: user._id.toString() },
          'password hash upgraded',
        );
      }
      user.lastLoginAt = new Date();
      await user.save();

      log.info({ event: 'auth.login.succeeded', userId: user._id.toString() }, 'login succeeded');
      return user;
    },
  };
}
