/**
 * Minimal deterministic migration runner — executes packages/db/migrations/*.sql
 * in filename order, records applied files in _migrations. Runs on API boot.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function runMigrations(pool: pg.Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    // serialize concurrent boots (api + worker share the db)
    await client.query('SELECT pg_advisory_lock(109912201)');
    try {
      const done = new Set(
        (await client.query('SELECT filename FROM _migrations')).rows.map((r: { filename: string }) => r.filename),
      );
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        if (done.has(file)) continue;
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        log(`applying migration ${file}`);
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
          await client.query('COMMIT');
          applied.push(file);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(109912201)');
    }
  } finally {
    client.release();
  }
  return applied;
}
