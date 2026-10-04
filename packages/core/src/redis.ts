import { Redis } from 'ioredis';

let client: Redis | undefined;

export function getRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379/3'): Redis {
  if (!client) {
    client = new Redis(url, { maxRetriesPerRequest: null });
  }
  return client;
}

/**
 * BullMQ requires its own connection options (not a shared client for blocking
 * ops). The URL is handed to ioredis untouched — exactly as getRedis() does — so
 * an ACL username, a percent-encoded password and rediss:// TLS all resolve the
 * same way for queues/workers as for sessions (a hand parser dropped all three).
 */
export function redisConnectionOptions(url = process.env.REDIS_URL ?? 'redis://localhost:6379/3') {
  return { url, maxRetriesPerRequest: null as null };
}

export async function closeRedis(): Promise<void> {
  if (client) {
    client.disconnect();
    client = undefined;
  }
}
