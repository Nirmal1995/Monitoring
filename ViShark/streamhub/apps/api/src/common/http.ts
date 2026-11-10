/**
 * Response envelope used by every endpoint.
 *
 *   success: { "data": ..., "meta": { ... } }
 *   failure: { "error": { "code", "message", "requestId", "details"? } }
 */
export type SuccessBody<T> = { data: T; meta?: Record<string, unknown> };

export type ErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};

export const ok = <T>(data: T, meta?: Record<string, unknown>): SuccessBody<T> =>
  meta ? { data, meta } : { data };
