import type { RequestHandler } from 'express';
import mongoose from 'mongoose';
import { serviceUnavailable } from './rate-limit.ts';

/**
 * Fails fast with 503 when MongoDB is not connected, instead of letting the
 * session store wait on a connection that is not there.
 */
export const requireDatabase: RequestHandler = (_req, _res, next) => {
  next(
    mongoose.connection.readyState === mongoose.ConnectionStates.connected
      ? undefined
      : serviceUnavailable(),
  );
};
