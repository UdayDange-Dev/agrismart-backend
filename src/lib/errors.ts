export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = () => new AppError(401, 'unauthorized', 'Authentication required');
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'unprocessable', message, details);
export const tooManyRequests = (message = 'Too many requests, please try again later') =>
  new AppError(429, 'rate_limited', message);
export const serviceUnavailable = (message = 'Service temporarily unavailable') =>
  new AppError(503, 'service_unavailable', message);
