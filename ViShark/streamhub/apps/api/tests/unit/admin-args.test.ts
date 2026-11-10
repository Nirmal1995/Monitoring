import { describe, expect, it } from 'vitest';
import {
  AdminBootstrapError,
  parseCreateAdminArgs,
} from '../../src/modules/admin/admin-bootstrap.ts';

describe('parseCreateAdminArgs', () => {
  it('normalises the email and applies defaults', () => {
    expect(parseCreateAdminArgs(['--email', ' Root@Example.COM '])).toEqual({
      email: 'root@example.com',
      name: 'Administrator',
      promote: false,
    });
  });

  it('accepts --name and --promote', () => {
    expect(
      parseCreateAdminArgs(['--email', 'a@b.co', '--name', 'Site Admin', '--promote']),
    ).toEqual({
      email: 'a@b.co',
      name: 'Site Admin',
      promote: true,
    });
  });

  it.each([
    ['missing email', []],
    ['invalid email', ['--email', 'not-an-email']],
    ['empty name', ['--email', 'a@b.co', '--name', '  ']],
    [
      'a password argument (never allowed on the command line)',
      ['--email', 'a@b.co', '--password', 'secret-secret'],
    ],
    ['unknown option', ['--email', 'a@b.co', '--role', 'ADMIN']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseCreateAdminArgs(argv)).toThrow(AdminBootstrapError);
  });
});
