import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { describe } from '../services/catalogService.js';

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

const send = (res: Response, status: number, body: Omit<ErrorBody['error'], 'requestId'>) => {
  const payload: ErrorBody = { error: { ...body, requestId: res.locals.requestId } };
  res.status(status).json(payload);
};

export function notFoundHandler(_req: Request, res: Response): void {
  send(res, 404, { code: 'not_found', message: 'Resource not found' });
}

/**
 * Central error handler. Clients only ever receive a stable code, a safe message and the
 * request id; stack traces, database errors and upstream details stay in server logs.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    req.log?.error({ err: describe(err) }, 'Error after response started');
    res.end();
    return;
  }

  if (err instanceof ZodError) {
    // Only paths and rule messages are returned; submitted values are never echoed.
    const details = err.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
    send(res, 400, { code: 'validation_error', message: 'The request contains invalid data', details });
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) req.log?.error({ code: err.code }, err.message);
    send(res, err.status, { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }

  // body-parser errors carry a `type` and an HTTP status.
  const parserType = (err as { type?: string })?.type;
  if (parserType === 'entity.too.large') {
    send(res, 413, { code: 'payload_too_large', message: 'Request body is too large' });
    return;
  }
  if (parserType === 'entity.parse.failed' || parserType === 'encoding.unsupported' || parserType === 'charset.unsupported') {
    send(res, 400, { code: 'invalid_body', message: 'Request body could not be parsed' });
    return;
  }

  req.log?.error({ err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : describe(err) }, 'Unhandled error');
  send(res, 500, { code: 'internal_error', message: 'An unexpected error occurred' });
}
