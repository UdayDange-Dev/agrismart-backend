import mongoose from 'mongoose';
import type { Logger } from 'pino';

/** Global query hardening: wrap `$`-prefixed objects from filters in `$eq` and reject unknown filter paths. */
export function applyMongooseHardening(): void {
  mongoose.set('sanitizeFilter', true);
  mongoose.set('strictQuery', 'throw');
  mongoose.set('autoIndex', true);
}

export async function connectMongo(uri: string, logger: Logger): Promise<mongoose.Connection> {
  applyMongooseHardening();
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err: Error) => logger.error({ err: { name: err.name } }, 'MongoDB connection error'));
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
    maxPoolSize: 10,
    minPoolSize: 1,
    retryWrites: true,
  });
  logger.info('MongoDB connected');
  return mongoose.connection;
}

export const isMongoReady = (): boolean => mongoose.connection.readyState === 1;

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
