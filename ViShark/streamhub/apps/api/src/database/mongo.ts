import mongoose from 'mongoose';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.ts';

// Safety settings (sanitizeFilter, strictQuery, no buffering): see mongoose-settings.ts.
import './mongoose-settings.ts';

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
