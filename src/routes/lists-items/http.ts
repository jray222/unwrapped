import type { Response } from 'express';

/**
 * If err carries a 400/403 status (e.g. HttpError), send it as a JSON error and return true.
 * Otherwise return false so the caller can forward to next(err).
 */
export function respondIfClientError(err: any, res: Response): boolean {
  if (err?.status === 403 || err?.status === 400) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}
