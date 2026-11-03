/**
 * An error carrying an HTTP status code. Thrown from route handlers and services;
 * the central error handler in app.ts (and route-level catches) turn it into a JSON response.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
