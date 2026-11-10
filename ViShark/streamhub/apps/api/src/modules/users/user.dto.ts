import type { UserDto } from '@streamhub/contracts';
import type { UserDocument } from './user.model.ts';

/**
 * Converts a database document into the public API shape. Only listed fields
 * leave the API: password hashes, status flags and future internal fields can
 * never leak through a response by accident.
 */
export function toUserDto(
  user: Pick<
    UserDocument,
    '_id' | 'email' | 'displayName' | 'role' | 'emailVerifiedAt' | 'createdAt'
  >,
): UserDto {
  return {
    id: user._id.toString(),
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    emailVerified: Boolean(user.emailVerifiedAt),
    createdAt: user.createdAt.toISOString(),
  };
}
