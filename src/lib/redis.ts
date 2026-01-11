import Redis from 'ioredis';
import { config } from '../config';

// Singleton pattern for Redis client
const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

export const redis = globalForRedis.redis ?? new Redis(config.redis.url, {
  maxRetriesPerRequest: null, // Required for BullMQ
});

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}

export default redis;
