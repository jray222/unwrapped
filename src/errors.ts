/**
 * Error carrying an HTTP status code. Route catch blocks check `err.status`
 * and respond with `{ error: err.message }`; `code` is an optional
 * machine-readable reason (used by redirect-style flows).
 */
export class HttpError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message?: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
