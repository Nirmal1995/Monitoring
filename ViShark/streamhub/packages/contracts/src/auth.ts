import { z } from 'zod';

/**
 * Request and response shapes for authentication, shared by the API (which
 * enforces them) and the web app (which uses them for form validation).
 *
 * Password policy follows OWASP ASVS: length is what matters. At least 12
 * characters, at most 128 (bounds hashing cost), any characters allowed, no
 * composition rules ("one uppercase, one symbol"), which push users toward
 * predictable patterns.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'must be a valid email address' }))
  .meta({ example: 'you@example.com' });

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .meta({ example: 'correct horse battery staple' });

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(60, 'must be at most 60 characters')
  // Printable characters only: no control characters or bidi overrides that
  // could be used to spoof names in the UI.
  .regex(/^[^\p{C}]+$/u, 'contains invalid characters')
  .meta({ example: 'Alex Murphy' });

export const registerBodySchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

export const loginBodySchema = z.strictObject({
  email: emailSchema,
  // Not validated against the policy on login: an old account may predate a
  // policy change, and the error must not hint at what a valid password is.
  password: z
    .string()
    .min(1)
    .max(PASSWORD_MAX_LENGTH)
    .meta({ example: 'correct horse battery staple' }),
});

export const updateProfileBodySchema = z.strictObject({
  displayName: displayNameSchema,
});

export const sessionHandleParamsSchema = z.strictObject({
  handle: z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'invalid session handle'),
});

/** Single-use tokens from emails: 32 random bytes, base64url encoded. */
export const emailTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'invalid or expired token')
  .meta({ example: 'kq0Zp3v9Y8WcN2bT7xR1uLmH6aJdFgEsQiOyUwVzXtA' });

export const verifyEmailBodySchema = z.strictObject({ token: emailTokenSchema });

/** Body for endpoints that send an email to an address (resend verification, forgot password). */
export const emailOnlyBodySchema = z.strictObject({ email: emailSchema });

export const resetPasswordBodySchema = z.strictObject({
  token: emailTokenSchema,
  password: passwordSchema,
});

export const changePasswordBodySchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});

export const deactivateAccountBodySchema = z.strictObject({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const roleSchema = z.enum(['USER', 'ADMIN']);

export const userDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  emailVerified: z.boolean(),
  createdAt: z.string(),
});

export const sessionDtoSchema = z.object({
  handle: z.string(),
  current: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;
export type VerifyEmailBody = z.infer<typeof verifyEmailBodySchema>;
export type EmailOnlyBody = z.infer<typeof emailOnlyBodySchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type DeactivateAccountBody = z.infer<typeof deactivateAccountBodySchema>;
export type UserDto = z.infer<typeof userDtoSchema>;
export type SessionDto = z.infer<typeof sessionDtoSchema>;
