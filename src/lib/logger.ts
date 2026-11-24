import { pino, type DestinationStream, type Logger } from 'pino';

/** Paths that must never reach log output (secrets and personal data). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-order-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.apiKey',
  '*.apiSecret',
  '*.authorization',
  '*.email',
  '*.phone',
  '*.message',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'agrismart-api' },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

export type { Logger };
