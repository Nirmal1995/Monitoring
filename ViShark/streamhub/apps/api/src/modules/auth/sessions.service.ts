import type { SessionDto } from '@streamhub/contracts';
import mongoose from 'mongoose';
import { SESSIONS_COLLECTION } from './session.ts';

/**
 * Lists and revokes a user's sessions directly in the sessions collection.
 * Every query is scoped by userId, so one user can never see or revoke
 * another user's sessions even with a guessed or stolen handle.
 */
type StoredSession = {
  _id: string;
  expires: Date;
  session: {
    userId: string;
    handle: string;
    createdAt: number;
    lastSeenAt: number;
    userAgent: string | null;
    ip: string | null;
  };
};

const collection = () => mongoose.connection.collection<StoredSession>(SESSIONS_COLLECTION);

export async function ensureSessionIndexes(): Promise<void> {
  await collection().createIndex({ 'session.userId': 1 }, { name: 'session_userId' });
}

export async function listSessions(
  userId: string,
  currentHandle: string | undefined,
): Promise<SessionDto[]> {
  const docs = await collection()
    .find({ 'session.userId': userId, expires: { $gt: new Date() } })
    .sort({ 'session.lastSeenAt': -1 })
    .limit(100)
    .toArray();
  return docs.map(({ session }) => ({
    handle: session.handle,
    current: session.handle === currentHandle,
    createdAt: new Date(session.createdAt).toISOString(),
    lastSeenAt: new Date(session.lastSeenAt).toISOString(),
    userAgent: session.userAgent,
    ip: session.ip,
  }));
}

export async function revokeSession(userId: string, handle: string): Promise<boolean> {
  const result = await collection().deleteOne({
    'session.userId': userId,
    'session.handle': handle,
  });
  return result.deletedCount === 1;
}

export async function revokeOtherSessions(
  userId: string,
  keepHandle: string | undefined,
): Promise<number> {
  const result = await collection().deleteMany({
    'session.userId': userId,
    ...(keepHandle ? { 'session.handle': { $ne: keepHandle } } : {}),
  });
  return result.deletedCount;
}

/** Revokes every session of a user, including the current one. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await collection().deleteMany({ 'session.userId': userId });
  return result.deletedCount;
}
