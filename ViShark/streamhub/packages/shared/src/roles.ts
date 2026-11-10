/**
 * Roles are a closed set. Authorization decisions are made on the server
 * from the role stored in the user's database record, never from a value
 * supplied by the client.
 */
export const ROLES = ['USER', 'ADMIN'] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
