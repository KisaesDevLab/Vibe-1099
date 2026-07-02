import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: Db | undefined;

export function getPool(databaseUrl = process.env.DATABASE_URL): pg.Pool {
  if (!pool) {
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  }
  return pool;
}

export function getDb(databaseUrl?: string): Db {
  if (!db) {
    db = drizzle(getPool(databaseUrl), { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}

export { schema };
