/**
 * API boot: env validation (fail-fast) → migrations → Vibe Auth start → listen on 8210.
 */
import { createLogger, loadEnv } from '@vibe1099/core';
import { getPool, runMigrations } from '@vibe1099/db';
import { createApp } from './app.js';
import { startVibeAuth } from './lib/vibeAuth.js';

const log = createLogger('api:boot');

async function main(): Promise<void> {
  const env = loadEnv(); // throws with a readable report on bad config
  log.info('environment validated');

  await runMigrations(getPool(env.DATABASE_URL), (m) => log.info(m));
  log.info('migrations up to date');

  // Vibe Auth (SSO): resolves mode/IdP config and starts discovery. Its only throw
  // — oidc_only with no break-glass admin — must abort boot with its message (I4).
  await startVibeAuth();

  const app = createApp();
  app.listen(env.API_PORT, () => {
    log.info(`vibe1099-api listening on :${env.API_PORT}`);
  });
}

main().catch((err) => {
  log.fatal(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
