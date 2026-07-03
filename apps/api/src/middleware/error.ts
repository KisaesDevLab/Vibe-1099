import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, ErrorCodes } from '@vibe1099/shared';
import { createLogger, redactPii } from '@vibe1099/core';

const log = createLogger('api:error');

/** Scrub TIN-shaped values out of error details before they reach the client —
 * provider (IRIS/Tax1099) rejections can echo submitted TIN/name fragments. */
function scrubDetails(details: unknown): unknown {
  if (details === undefined) return undefined;
  try {
    return JSON.parse(redactPii(JSON.stringify(details)));
  } catch {
    return undefined;
  }
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: redactPii(err.message), details: scrubDetails(err.details) } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: ErrorCodes.E_VALIDATION,
        message: 'Validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  log.error({ err, requestId: req.requestId, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: ErrorCodes.E_INTERNAL, message: 'Internal error' } });
}

/** async route wrapper */
export function h(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
