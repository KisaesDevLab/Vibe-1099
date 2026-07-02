import { Redis } from 'ioredis';

let client: Redis | undefined;

export function getRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379/3'): Redis {
  if (!client) {
    client = new Redis(url, { maxRetriesPerRequest: null });
  }
  return client;
}

/** BullMQ requires its own connection options (not a shared client for blocking ops). */
export function redisConnectionOptions(url = process.env.REDIS_URL ?? 'redis://localhost:6379/3') {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 6379,
    db: u.pathname && u.pathname !== '/' ? parseInt(u.pathname.slice(1), 10) : 0,
    password: u.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}

export async function closeRedis(): Promise<void> {
  if (client) {
    client.disconnect();
    client = undefined;
  }
}
