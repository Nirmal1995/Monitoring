import mongoose from 'mongoose';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.ts';

/**
 * Global Mongoose safety settings, applied before any model is defined.
 *
 * sanitizeFilter: wraps query filter values that look like operators
 *   (for example {"$ne": null} arriving from JSON input) in $eq, which blocks
 *   the classic NoSQL injection "log in as anyone" payload at the ODM level.
 *   Request validation (Zod) is the first line of defence; this is the second.
 * strictQuery: filters on fields not in the schema are dropped.
 * bufferCommands=false: if the database is down, queries fail immediately
 *   instead of queueing in memory and hanging the request.
 */
mongoose.set('sanitizeFilter', true);
mongoose.set('strictQuery', true);
mongoose.set('bufferCommands', false);

export type MongoConnection = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  ping: () => Promise<void>;
};

/** Removes credentials from a connection string before it is logged. */
export function redactMongoUrl(url: string): string {
  return url.replace(/\/\/([^@/]+)@/, '//***:***@');
}

export function createMongoConnection(
  config: Pick<AppConfig, 'MONGO_URL' | 'MONGO_SERVER_SELECTION_TIMEOUT_MS' | 'NODE_ENV'>,
  logger: Logger,
): MongoConnection {
  const log = logger.child({ component: 'mongo' });
  const conn = mongoose.connection;

  conn.on('connected', () => log.info('connected'));
  conn.on('disconnected', () => log.warn('disconnected'));
  conn.on('reconnected', () => log.info('reconnected'));
  conn.on('error', (err: Error) => log.error({ err }, 'connection error'));

  return {
    async connect() {
      log.info({ url: redactMongoUrl(config.MONGO_URL) }, 'connecting');
      await mongoose.connect(config.MONGO_URL, {
        serverSelectionTimeoutMS: config.MONGO_SERVER_SELECTION_TIMEOUT_MS,
        // Index builds at startup are convenient locally but can lock large
        // production collections; production indexes go through migrations.
        autoIndex: config.NODE_ENV !== 'production',
        maxPoolSize: 20,
      });
    },
    async disconnect() {
      await mongoose.disconnect();
    },
    async ping() {
      const db = conn.db;
      if (conn.readyState !== mongoose.ConnectionStates.connected || !db) {
        throw new Error('not connected');
      }
      await db.command({ ping: 1 });
    },
  };
}
