import type { Response, NextFunction } from 'express';
import { HttpError } from '../../errors.js';

/** Respond with `{ error }` for HttpError; forward anything else to the error middleware. */
export function handleRouteError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
}
