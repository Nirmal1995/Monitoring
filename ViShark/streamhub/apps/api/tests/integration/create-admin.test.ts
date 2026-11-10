import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminBootstrapError, createAdmin } from '../../src/modules/admin/admin-bootstrap.ts';
import { createPasswordHasher } from '../../src/modules/auth/password.ts';
import { UserModel } from '../../src/modules/users/user.model.ts';
import { silentLogger } from '../helpers.ts';
import {
  PASSWORD,
  connectTestInfra,
  createUser,
  disconnectTestInfra,
  resetTestData,
  testConfig,
} from './setup.ts';

const config = testConfig();
const deps = (password = PASSWORD) => ({
  readPassword: vi.fn(() => Promise.resolve(password)),
  hasher: createPasswordHasher(config),
  logger: silentLogger,
});
const options = { email: 'root@example.com', name: 'Site Admin', promote: false };

beforeAll(async () => {
  await connectTestInfra();
});
beforeEach(resetTestData);
afterAll(disconnectTestInfra);

describe('createAdmin (in-process)', () => {
  it('creates a verified ADMIN with an Argon2id hash', async () => {
    await expect(createAdmin(options, deps())).resolves.toBe('created');
    const admin = await UserModel.findOne({ email: 'root@example.com' })
      .select('+passwordHash')
      .lean();
    expect(admin).toMatchObject({ role: 'ADMIN', displayName: 'Site Admin', status: 'ACTIVE' });
    expect(admin?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(admin?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('is idempotent for an existing admin and never asks for or changes the password', async () => {
    await createAdmin(options, deps());
    const before = await UserModel.findOne({ email: 'root@example.com' })
      .select('+passwordHash')
      .lean();
    const second = deps('a different password entirely');
    await expect(createAdmin(options, second)).resolves.toBe('unchanged');
    expect(second.readPassword).not.toHaveBeenCalled();
    const after = await UserModel.findOne({ email: 'root@example.com' })
      .select('+passwordHash')
      .lean();
    expect(after?.passwordHash).toBe(before?.passwordHash);
  });

  it('refuses to silently promote an existing user, and promotes with --promote', async () => {
    await createUser({ email: 'someone@example.com' });
    const target = { ...options, email: 'someone@example.com' };
    await expect(createAdmin(target, deps())).rejects.toThrow(/--promote/);
    expect((await UserModel.findOne({ email: 'someone@example.com' }).lean())?.role).toBe('USER');

    const promote = deps();
    await expect(createAdmin({ ...target, promote: true }, promote)).resolves.toBe('promoted');
    expect(promote.readPassword).not.toHaveBeenCalled();
    expect((await UserModel.findOne({ email: 'someone@example.com' }).lean())?.role).toBe('ADMIN');
  });

  it('enforces the password policy and creates nothing on failure', async () => {
    await expect(createAdmin(options, deps('short'))).rejects.toThrow(AdminBootstrapError);
    expect(await UserModel.countDocuments()).toBe(0);
  });
});

/**
 * One end-to-end run of the real command in a child process (stdin, exit
 * code, output). Starting a fresh Node process that loads TypeScript, Mongoose
 * and argon2 is slow on the /mnt/e filesystem (about 45 s measured), hence
 * the long timeout and a single smoke test; behaviour is covered above.
 */
describe('admin:create command (end-to-end smoke test)', () => {
  it('creates an admin from stdin and never prints the password', async () => {
    const apiDir = fileURLToPath(new URL('../..', import.meta.url));
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli/create-admin.ts',
        '--email',
        'Cli@Example.com',
        '--name',
        'CLI Admin',
      ],
      {
        cwd: apiDir,
        env: {
          ...process.env,
          MONGO_URL: config.MONGO_URL,
          REDIS_URL: config.REDIS_URL,
          SESSION_SECRET: config.SESSION_SECRET,
          LOG_LEVEL: 'silent',
        },
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stdin.end(`${PASSWORD}\n`);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

    expect(output).toContain('Created administrator cli@example.com');
    expect(code).toBe(0);
    expect(output).not.toContain(PASSWORD);
    expect((await UserModel.findOne({ email: 'cli@example.com' }).lean())?.role).toBe('ADMIN');
  }, 180_000);
});
