// Domain errors carry an HTTP status and a stable `code` the frontend can match on.
// All thrown errors funnel through the centralized error handler in app.ts.

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (msg = 'Bad request', details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details),
  unauthorized: (msg = 'Unauthorized') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg = 'Conflict', details?: unknown) => new AppError(409, 'CONFLICT', msg, details),
  tooManyRequests: (msg = 'Too many requests') => new AppError(429, 'RATE_LIMITED', msg),
  // v2.5.22 (W1.1): profile-module gate. Code stays lowercase `module_disabled`
  // — the pre-existing stable code the frontend ModuleDisabledBanner matches on
  // (do NOT rename to MODULE_DISABLED; that would break the banner). 403, not
  // 404: these are team-visible projects, not secrets.
  moduleDisabled: (moduleKey: string) =>
    new AppError(403, 'module_disabled', `The "${moduleKey}" module is not enabled for this project`, {
      moduleKey,
    }),
  internal: (msg = 'Internal server error') => new AppError(500, 'INTERNAL', msg),
  serviceUnavailable: (msg = 'Service temporarily unavailable') =>
    new AppError(503, 'SERVICE_UNAVAILABLE', msg),
};
