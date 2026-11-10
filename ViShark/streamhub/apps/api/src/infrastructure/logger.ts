import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from '../config/env.ts';

/**
 * Paths removed from every log line. Pino redaction is applied at
 * serialization time, so a value never reaches the log destination even if a
 * developer logs a whole request or user object by mistake.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.sessionId',
  '*.secret',
  '*.accessKeyId',
  '*.secretAccessKey',
];

export function createLogger(
  config: Pick<AppConfig, 'LOG_LEVEL' | 'LOG_PRETTY' | 'NODE_ENV'>,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { service: 'streamhub-api', env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      // "level": "info" instead of numeric 30: friendlier for CloudWatch queries.
      level: (label) => ({ level: label }),
    },
  };
  if (config.LOG_PRETTY && !destination) {
    options.transport = {
      target: 'pino-pretty',
      options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    };
  }
  return destination ? pino(options, destination) : pino(options);
}
