/**
 * Creates the initial administrator, or promotes an existing user.
 *
 *   pnpm admin:create --email admin@example.com --name "Site Admin"
 *   pnpm admin:create --email someone@example.com --promote
 *
 * The password is read with a hidden prompt, or from the first line of stdin
 * when stdin is not a terminal (automation). It is never accepted as an
 * argument. There is no default admin account anywhere in the code.
 *
 * This file only does terminal I/O and connection handling; the logic lives
 * in modules/admin/admin-bootstrap.ts.
 */
import mongoose from 'mongoose';
import { loadConfig } from '../config/env.ts';
import { createLogger } from '../infrastructure/logger.ts';
import {
  AdminBootstrapError,
  createAdmin,
  parseCreateAdminArgs,
} from '../modules/admin/admin-bootstrap.ts';
import { createPasswordHasher } from '../modules/auth/password.ts';

function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          reject(new AdminBootstrapError('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += String(chunk);
    return data.split(/\r?\n/)[0] ?? '';
  }
  const password = await promptHidden('Password: ');
  const confirm = await promptHidden('Repeat password: ');
  if (password !== confirm) throw new AdminBootstrapError('passwords do not match');
  return password;
}

const MESSAGES = {
  created: (email: string) => `Created administrator ${email}.`,
  promoted: (email: string) => `Promoted ${email} to administrator.`,
  unchanged: (email: string) => `${email} is already an administrator. Nothing changed.`,
};

async function main(): Promise<void> {
  const options = parseCreateAdminArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_PRETTY: false });
  await mongoose.connect(config.MONGO_URL, {
    serverSelectionTimeoutMS: config.MONGO_SERVER_SELECTION_TIMEOUT_MS,
  });
  try {
    const result = await createAdmin(options, {
      readPassword,
      hasher: createPasswordHasher(config),
      logger,
    });
    console.log(MESSAGES[result](options.email));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`admin:create failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
