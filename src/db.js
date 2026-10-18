import mongoose from 'mongoose';
import { config } from './config.js';
import { logger } from './lib/logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri = config.mongoUri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  logger.info(`MongoDB connected: ${mongoose.connection.name}`);
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
