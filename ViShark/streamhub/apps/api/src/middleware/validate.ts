import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { badRequest } from '../common/errors.ts';

/**
 * Central request validation. Each route declares Zod schemas for the parts
 * of the request it accepts; anything else is rejected before the handler
 * runs. Schemas are strict objects, so unknown fields (mass assignment
 * attempts such as {"role": "ADMIN"}) fail validation instead of being
 * silently passed through.
 *
 * Parsed values are stored in res.locals.validated (Express 5 makes req.query
 * read-only, and keeping raw and parsed input separate is clearer anyway).
 */
type Schemas = {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
};

export type Validated<S extends Schemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.infer<S[K]> : never;
};

export function validate<S extends Schemas>(schemas: S): RequestHandler {
  return (req, res, next) => {
    const validated: Record<string, unknown> = {};
    const issues: { location: string; path: string; message: string }[] = [];

    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location] ?? {});
      if (result.success) {
        validated[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      next(badRequest('Request validation failed', issues));
      return;
    }
    res.locals.validated = validated;
    next();
  };
}
