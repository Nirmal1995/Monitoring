import { describe, expect, it } from 'vitest';
import { ROLES, isRole } from './roles.ts';

describe('isRole', () => {
  it('accepts every defined role', () => {
    for (const role of ROLES) {
      expect(isRole(role)).toBe(true);
    }
  });

  it.each([
    ['lowercase variant', 'admin'],
    ['unknown role', 'SUPERADMIN'],
    ['empty string', ''],
    ['number', 1],
    ['null', null],
    ['object (NoSQL operator shape)', { $ne: null }],
  ])('rejects %s', (_label, value) => {
    expect(isRole(value)).toBe(false);
  });
});
