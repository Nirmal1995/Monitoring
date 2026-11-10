import { createHash, randomBytes } from 'node:crypto';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

/**
 * Single-use, time-limited tokens sent by email (email verification and
 * password reset).
 *
 * - The raw token (256 random bits) exists only in the email. The database
 *   stores its SHA-256, so someone reading the database cannot use pending tokens.
 * - SHA-256 rather than Argon2 is correct here: the token is high-entropy
 *   random data, not a human-chosen password, so it cannot be brute-forced.
 * - Consumption is one atomic findOneAndDelete: two simultaneous requests with
 *   the same token cannot both succeed.
 * - A TTL index on expiresAt deletes expired tokens automatically.
 * - Issuing a new token deletes the user's previous ones (only the latest link works).
 */
type TokenDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
};

function tokenModel(name: string, collection: string): Model<TokenDocument> {
  const existing = mongoose.models[name] as Model<TokenDocument> | undefined;
  if (existing) return existing;
  const schema = new Schema<TokenDocument>(
    {
      userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      tokenHash: { type: String, required: true, unique: true },
      expiresAt: { type: Date, required: true, expires: 0 },
    },
    { timestamps: { createdAt: true, updatedAt: false }, collection, strict: 'throw' },
  );
  return mongoose.model<TokenDocument>(name, schema);
}

export const EmailVerificationTokenModel = tokenModel(
  'EmailVerificationToken',
  'emailVerificationTokens',
);
export const PasswordResetTokenModel = tokenModel('PasswordResetToken', 'passwordResetTokens');

/**
 * "Not yet expired" filter. With sanitizeFilter on, operators in filters are
 * treated as untrusted input; mongoose.trusted() marks this one as ours.
 */
const notExpired = () => mongoose.trusted({ $gt: new Date() }) as unknown as Date;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export type TokenStore = {
  issue: (userId: Types.ObjectId) => Promise<string>;
  /** Looks a token up without using it (to validate input before consuming). */
  peek: (token: string) => Promise<Types.ObjectId | null>;
  consume: (token: string) => Promise<Types.ObjectId | null>;
  revokeAll: (userId: Types.ObjectId) => Promise<void>;
};

export function createTokenStore(model: Model<TokenDocument>, ttlMs: number): TokenStore {
  return {
    async issue(userId) {
      await model.deleteMany({ userId });
      const token = randomBytes(32).toString('base64url');
      await model.create({
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + ttlMs),
      });
      return token;
    },
    async peek(token) {
      const doc = await model
        .findOne({ tokenHash: hashToken(token), expiresAt: notExpired() })
        .lean<TokenDocument>();
      return doc?.userId ?? null;
    },
    async consume(token) {
      const doc = await model
        .findOneAndDelete({ tokenHash: hashToken(token), expiresAt: notExpired() })
        .lean<TokenDocument>();
      return doc?.userId ?? null;
    },
    async revokeAll(userId) {
      await model.deleteMany({ userId });
    },
  };
}
