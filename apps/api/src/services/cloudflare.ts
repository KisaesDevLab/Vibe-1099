/**
 * Cloudflare Tunnel management (public ingress for the appliance).
 *
 * The appliance exposes its public zones (recipient portal, W-9, client portal,
 * provider webhooks) to the internet only through a Cloudflare Tunnel — no inbound
 * ports. This service lets an admin configure a remotely-managed tunnel TOKEN from
 * the UI: the token is stored encrypted, written to a shared file the `cloudflared`
 * sidecar runs with, and the sidecar's live connection status is read back from its
 * metrics endpoint. Ingress hostnames/paths are managed in the Cloudflare Zero
 * Trust dashboard (that's how remotely-managed tunnels work); we surface the exact
 * paths the operator must map.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getCrypto, loadEnv } from '@vibe1099/core';
import { getSetting, setSetting } from './settings.js';

const TOKEN_KEY = 'cloudflare_tunnel_token'; // stored ENCRYPTED
const HOSTNAME_KEY = 'cloudflare_public_hostname';

/** The public path prefixes that must be routed to this app (port 8210/8211). */
export const PUBLIC_PATHS = [
  { path: '/api/portal', desc: 'Recipient portal (Copy B access, identity-challenged)' },
  { path: '/api/w9-public', desc: 'W-9 collection portal' },
  { path: '/api/client-portal', desc: 'Client (payer) portal' },
  { path: '/api/webhooks/taxbandits', desc: 'TaxBandits status webhooks' },
];

export interface CloudflareConfig {
  hasToken: boolean;
  hostname: string;
}

export async function getCloudflareConfig(): Promise<CloudflareConfig> {
  const enc = await getSetting<string>(TOKEN_KEY);
  const hostname = (await getSetting<string>(HOSTNAME_KEY)) ?? '';
  return { hasToken: !!enc, hostname };
}

/**
 * Save the tunnel token (encrypted) and/or public hostname. When a token is set,
 * also write it (plaintext) to the shared file the cloudflared sidecar runs with.
 * The sidecar must be restarted to pick up a changed token (surfaced in the UI).
 */
export async function saveCloudflareConfig(input: { token?: string; hostname?: string }): Promise<{ tokenWritten: boolean }> {
  let tokenWritten = false;
  if (input.token) {
    await setSetting(TOKEN_KEY, getCrypto().encrypt(input.token));
    try {
      const file = loadEnv().CLOUDFLARE_TOKEN_FILE;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, input.token, { mode: 0o600 });
      tokenWritten = true;
    } catch {
      // shared volume not present (e.g. local dev) — token still stored encrypted;
      // the operator can inject it into the cloudflared sidecar via env instead.
    }
  }
  if (input.hostname !== undefined) await setSetting(HOSTNAME_KEY, input.hostname.trim());
  return { tokenWritten };
}

export interface TunnelStatus {
  running: boolean;
  readyConnections: number | null;
  detail: string;
}

/** Live status from the cloudflared sidecar metrics endpoint (`/ready`). */
export async function tunnelStatus(): Promise<TunnelStatus> {
  const url = `${loadEnv().CLOUDFLARE_METRICS_URL.replace(/\/$/, '')}/ready`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json().catch(() => ({}))) as { status?: number; readyConnections?: number };
    const ready = body.readyConnections ?? 0;
    return {
      running: res.ok && ready > 0,
      readyConnections: body.readyConnections ?? null,
      detail: res.ok ? `${ready} edge connection(s)` : `cloudflared responded ${res.status}`,
    };
  } catch {
    return { running: false, readyConnections: null, detail: 'cloudflared not reachable — sidecar stopped or no token set' };
  }
}
