import { getPool, closeDb } from './client.js';
import { runMigrations } from './migrate.js';

const applied = await runMigrations(getPool(), (m) => console.log(m));
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
await closeDb();
