import type { Role } from './roles.ts';

/**
 * Permissions are what the code checks; roles are bundles of permissions.
 * Route handlers ask "can this user do X?", never "is this user an admin?",
 * so adding a role (for example a moderator) later means editing this table,
 * not every route.
 *
 * "own" permissions only allow acting on resources the user owns; the
 * ownership check itself happens in the service layer with the resource.
 */
export const PERMISSIONS = [
  'video:read',
  'video:manage',
  'category:manage',
  'user:manage',
  'audit:read',
  'stats:read',
  'profile:manage-own',
  'sessions:manage-own',
  'favourites:manage-own',
  'history:manage-own',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const USER_PERMISSIONS: readonly Permission[] = [
  'video:read',
  'profile:manage-own',
  'sessions:manage-own',
  'favourites:manage-own',
  'history:manage-own',
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  USER: USER_PERMISSIONS,
  ADMIN: PERMISSIONS,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
