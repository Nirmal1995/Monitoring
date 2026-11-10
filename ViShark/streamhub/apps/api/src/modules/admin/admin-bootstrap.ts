import { parseArgs } from 'node:util';
import { displayNameSchema, emailSchema, passwordSchema } from '@streamhub/contracts';
import type { Logger } from 'pino';
import type { PasswordHasher } from '../auth/password.ts';
import { assertPasswordAcceptable } from '../auth/password-policy.ts';
import { AppError } from '../../common/errors.ts';
import { UserModel } from '../users/user.model.ts';

/**
 * Logic behind `pnpm admin:create`, kept separate from the CLI entry point
 * (src/cli/create-admin.ts) so it can be tested in-process. The entry point
 * only handles terminal I/O and the database connection.
 */
export class AdminBootstrapError extends Error {}

export type CreateAdminOptions = { email: string; name: string; promote: boolean };

/**
 * Parses CLI arguments. Unknown options are rejected (strict), which includes
 * any attempt to pass --password: passwords must never be command-line
 * arguments, which end up in shell history and the process list.
 */
export function parseCreateAdminArgs(argv: string[]): CreateAdminOptions {
  let values: { email?: string; name?: string; promote?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: 'string' },
        name: { type: 'string', default: 'Administrator' },
        promote: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    throw new AdminBootstrapError(err instanceof Error ? err.message : 'invalid arguments');
  }
  const email = emailSchema.safeParse(values.email ?? '');
  if (!email.success)
    throw new AdminBootstrapError('--email is required and must be a valid email address');
  const name = displayNameSchema.safeParse(values.name);
  if (!name.success)
    throw new AdminBootstrapError(`--name ${name.error.issues[0]?.message ?? 'is invalid'}`);
  return { email: email.data, name: name.data, promote: values.promote ?? false };
}

export type CreateAdminResult = 'created' | 'promoted' | 'unchanged';

/**
 * Creates a verified ADMIN, or promotes an existing user when explicitly
 * asked. Expects an open Mongoose connection. The password is requested only
 * when a new account is actually created.
 */
export async function createAdmin(
  options: CreateAdminOptions,
  deps: { readPassword: () => Promise<string>; hasher: PasswordHasher; logger: Logger },
): Promise<CreateAdminResult> {
  await UserModel.init();
  const existing = await UserModel.findOne({ email: options.email }).exec();

  if (existing?.role === 'ADMIN') return 'unchanged';

  if (existing) {
    if (!options.promote) {
      throw new AdminBootstrapError(
        `a user with email ${options.email} already exists; re-run with --promote to make them an administrator`,
      );
    }
    existing.role = 'ADMIN';
    await existing.save();
    deps.logger.info(
      { event: 'admin.promoted', userId: existing._id.toString(), via: 'cli' },
      'user promoted to admin',
    );
    return 'promoted';
  }

  const password = passwordSchema.safeParse(await deps.readPassword());
  if (!password.success) {
    throw new AdminBootstrapError(`password ${password.error.issues[0]?.message ?? 'is invalid'}`);
  }
  try {
    assertPasswordAcceptable(password.data, options.email);
  } catch (err) {
    const reason =
      err instanceof AppError
        ? (err.details as { message: string }[] | undefined)?.[0]?.message
        : undefined;
    throw new AdminBootstrapError(`password rejected: ${reason ?? 'not acceptable'}`);
  }
  const user = await UserModel.create({
    email: options.email,
    passwordHash: await deps.hasher.hash(password.data),
    displayName: options.name,
    role: 'ADMIN',
    // The operator vouches for this address; there is no email round-trip.
    emailVerifiedAt: new Date(),
  });
  deps.logger.info(
    { event: 'admin.created', userId: user._id.toString(), via: 'cli' },
    'administrator created',
  );
  return 'created';
}
