import { createHash } from 'node:crypto';
import type {
  ChangePasswordBody,
  LoginBody,
  RegisterBody,
  ResetPasswordBody,
} from '@streamhub/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { AppError } from '../../common/errors.ts';
import { sendInBackground, type Mailer } from '../../infrastructure/mailer.ts';
import { hit } from '../../middleware/rate-limit.ts';
import { UserModel, type UserDocument } from '../users/user.model.ts';
import {
  accountDeactivatedEmail,
  alreadyRegisteredEmail,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from './emails.ts';
import type { LoginThrottle } from './login-throttle.ts';
import type { PasswordHasher } from './password.ts';
import { assertPasswordAcceptable } from './password-policy.ts';
import { revokeAllSessions } from './sessions.service.ts';
import type { TokenStore } from './tokens.ts';

export const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

export const invalidToken = () =>
  new AppError(
    400,
    'INVALID_TOKEN',
    'This link is invalid or has expired. Please request a new one.',
  );

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
  mailer: Mailer;
  redis: Redis;
  verificationTokens: TokenStore;
  resetTokens: TokenStore;
  settings: {
    requireEmailVerification: boolean;
    webOrigin: string;
    emailLimitPerHour: number;
    verificationTtlHours: number;
    resetTtlMinutes: number;
  };
}) {
  const { hasher, throttle, mailer, settings } = deps;
  const log = deps.logger.child({ component: 'auth' });
  const send = (message: Parameters<typeof sendInBackground>[1], event: string) =>
    sendInBackground(mailer, message, log, event);

  /**
   * Limits emails triggered for one address, whether or not it has an
   * account, so the app cannot be used to flood someone's inbox. Over the
   * limit the request still gets the normal response; the email is skipped.
   */
  async function emailAllowed(email: string, kind: string): Promise<boolean> {
    const { count } = await hit(deps.redis, `mail:${kind}:${emailFingerprint(email)}`, 3600);
    if (count > settings.emailLimitPerHour) {
      log.warn(
        { event: 'auth.email.limited', kind, email: emailFingerprint(email) },
        'email rate limit reached',
      );
      return false;
    }
    return true;
  }

  async function sendVerification(user: UserDocument): Promise<void> {
    const token = await deps.verificationTokens.issue(user._id);
    send(
      verificationEmail(
        user.email,
        user.displayName,
        settings.webOrigin,
        token,
        settings.verificationTtlHours,
      ),
      'auth.email.verification',
    );
  }

  return {
    /**
     * Creates an account. The response is identical whether or not the email
     * is already registered. A new account gets a verification email; an
     * existing owner gets a notice instead, so they learn about the attempt
     * and nobody else learns the account exists.
     */
    async register(input: RegisterBody): Promise<void> {
      assertPasswordAcceptable(input.password, input.email);
      // Hash first, even for duplicates, so both paths take the same time.
      const passwordHash = await hasher.hash(input.password);
      try {
        const user = await UserModel.create({
          email: input.email,
          passwordHash,
          displayName: input.displayName,
        });
        log.info({ event: 'auth.register', userId: user._id.toString() }, 'account created');
        await sendVerification(user);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        log.info(
          { event: 'auth.register.duplicate', email: emailFingerprint(input.email) },
          'email already registered',
        );
        const existing = await UserModel.findOne({ email: input.email }).exec();
        if (existing && (await emailAllowed(input.email, 'duplicate'))) {
          send(
            alreadyRegisteredEmail(existing.email, existing.displayName, settings.webOrigin),
            'auth.email.duplicate',
          );
        }
      }
    },

    async verifyEmail(token: string): Promise<void> {
      const userId = await deps.verificationTokens.consume(token);
      if (!userId) throw invalidToken();
      await UserModel.updateOne(
        { _id: userId, emailVerifiedAt: null },
        { $set: { emailVerifiedAt: new Date() } },
      );
      log.info({ event: 'auth.email.verified', userId: userId.toString() }, 'email verified');
    },

    /** Always succeeds from the caller's point of view (no account enumeration). */
    async resendVerification(email: string): Promise<void> {
      if (!(await emailAllowed(email, 'verification'))) return;
      const user = await UserModel.findOne({ email }).exec();
      if (user && !user.emailVerifiedAt && user.status === 'ACTIVE') await sendVerification(user);
    },

    /** Always succeeds from the caller's point of view (no account enumeration). */
    async forgotPassword(email: string): Promise<void> {
      if (!(await emailAllowed(email, 'reset'))) return;
      const user = await UserModel.findOne({ email }).exec();
      if (!user || user.status !== 'ACTIVE') {
        log.info(
          { event: 'auth.password.reset_requested_unknown', email: emailFingerprint(email) },
          'reset for unknown email',
        );
        return;
      }
      const token = await deps.resetTokens.issue(user._id);
      send(
        passwordResetEmail(
          user.email,
          user.displayName,
          settings.webOrigin,
          token,
          settings.resetTtlMinutes,
        ),
        'auth.email.reset',
      );
      log.info(
        { event: 'auth.password.reset_requested', userId: user._id.toString() },
        'password reset requested',
      );
    },

    /**
     * Sets a new password from a reset link. Every existing session is
     * revoked: if an attacker was signed in, resetting the password must
     * throw them out. Completing a reset also proves control of the inbox,
     * so the email counts as verified.
     */
    async resetPassword(input: ResetPasswordBody): Promise<void> {
      // Validate the new password before using up the token, so a rejected
      // password does not force the user to request another email.
      const pendingUserId = await deps.resetTokens.peek(input.token);
      if (!pendingUserId) throw invalidToken();
      const user = await UserModel.findById(pendingUserId).select('+passwordHash').exec();
      if (!user || user.status !== 'ACTIVE') throw invalidToken();
      assertPasswordAcceptable(input.password, user.email);
      // Atomic single use: of two concurrent requests, only one gets the token.
      const userId = await deps.resetTokens.consume(input.token);
      if (!userId?.equals(user._id)) throw invalidToken();

      user.passwordHash = await hasher.hash(input.password);
      user.passwordChangedAt = new Date();
      user.emailVerifiedAt ??= new Date();
      await user.save();
      await deps.resetTokens.revokeAll(user._id);
      const revoked = await revokeAllSessions(user._id.toString());
      await throttle.reset(user.email);

      log.info(
        { event: 'auth.password.reset', userId: user._id.toString(), revokedSessions: revoked },
        'password reset',
      );
      send(passwordChangedEmail(user.email, user.displayName), 'auth.email.password_changed');
    },

    /**
     * Changes the password of a signed-in user. Requires the current password
     * (a stolen session alone must not be enough to take over the account).
     * The caller rotates the current session and revokes the others.
     */
    async changePassword(userId: string, input: ChangePasswordBody): Promise<UserDocument> {
      const user = await UserModel.findById(userId).select('+passwordHash').exec();
      if (!user || !(await hasher.verify(user.passwordHash, input.currentPassword))) {
        throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'The current password is incorrect');
      }
      assertPasswordAcceptable(input.newPassword, user.email);
      user.passwordHash = await hasher.hash(input.newPassword);
      user.passwordChangedAt = new Date();
      await user.save();
      await deps.resetTokens.revokeAll(user._id);
      log.info({ event: 'auth.password.changed', userId }, 'password changed');
      send(passwordChangedEmail(user.email, user.displayName), 'auth.email.password_changed');
      return user;
    },

    /** Deactivates the signed-in user's account after re-checking the password. */
    async deactivate(userId: string, password: string): Promise<void> {
      const user = await UserModel.findById(userId).select('+passwordHash').exec();
      if (!user || !(await hasher.verify(user.passwordHash, password))) {
        throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'The password is incorrect');
      }
      user.status = 'DEACTIVATED';
      await user.save();
      const revoked = await revokeAllSessions(userId);
      log.info(
        { event: 'auth.account.deactivated', userId, revokedSessions: revoked },
        'account deactivated',
      );
      send(accountDeactivatedEmail(user.email, user.displayName), 'auth.email.deactivated');
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
      if (settings.requireEmailVerification && !user.emailVerifiedAt) {
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
