import mongoose from 'mongoose';

/**
 * Global Mongoose safety settings. Imported for its side effect by the
 * connection module AND by the integration tests, so tests always run with
 * exactly the production settings (an earlier test setup skipped this file
 * and missed a real bug).
 *
 * sanitizeFilter: query filter values that look like operators (for example
 *   {"$ne": null} arriving from JSON input) are wrapped in $eq, which blocks
 *   the classic NoSQL injection "log in as anyone" payload at the ODM level.
 *   Code that needs an operator on purpose must wrap it in mongoose.trusted().
 * strictQuery: filters on fields not in the schema are dropped.
 * bufferCommands=false: if the database is down, queries fail immediately
 *   instead of queueing in memory and hanging the request.
 */
mongoose.set('sanitizeFilter', true);
mongoose.set('strictQuery', true);
mongoose.set('bufferCommands', false);

export const MONGOOSE_SAFETY_SETTINGS = {
  sanitizeFilter: true,
  strictQuery: true,
  bufferCommands: false,
} as const;
