/** Adapter module for the `vibe-auth` CLI (break-glass account management, D12):
 *
 *    pnpm vibe-auth breakglass ensure | rotate | status
 *
 *  apps/api/package.json → "vibeAuth": { "adapter": "./src/vibeAuthAdapter.ts" }
 *  points the CLI here; the `vibe-auth` script runs the CLI under tsx so this
 *  TypeScript module loads. Inside the image the console runs
 *  `node --import tsx apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js …`
 *  from /app with VIBE_AUTH_ADAPTER pointing at this file. It runs with the same
 *  env as the API (DATABASE_URL, MASTER_KEY, VIBE_BREAKGLASS_USERNAME) and never
 *  starts the engine or Express. */
import type { VibeAuthCliAdapter } from '@kisaesdevlab/vibe-auth';
import { closeDb } from '@vibe1099/db';
import { BREAKGLASS_USERNAME, VIBE_1099_ROLES, breakglassEmailFor, createVibeUsers, vibeAuditSink } from './lib/vibeAuthUsers.js';

const adapter: VibeAuthCliAdapter = {
  users: createVibeUsers(),
  audit: vibeAuditSink,
  adminRole: VIBE_1099_ROLES.adminRole,
  breakglassEmail: breakglassEmailFor(BREAKGLASS_USERNAME),
  close: () => closeDb(),
};

export default adapter;
