import { describe, expect, it } from 'vitest';
import { PERMISSIONS, can } from './permissions.ts';

describe('can', () => {
  it('lets users act on their own data and read videos', () => {
    expect(can('USER', 'video:read')).toBe(true);
    expect(can('USER', 'profile:manage-own')).toBe(true);
  });

  it.each(['video:manage', 'category:manage', 'user:manage', 'audit:read', 'stats:read'] as const)(
    'denies users the admin permission %s',
    (permission) => {
      expect(can('USER', permission)).toBe(false);
    },
  );

  it('grants admins every permission', () => {
    for (const permission of PERMISSIONS) expect(can('ADMIN', permission)).toBe(true);
  });
});
