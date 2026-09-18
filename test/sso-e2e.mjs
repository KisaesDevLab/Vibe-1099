#!/usr/bin/env node
// Single sign-on end-to-end check for Vibe 1099 (Vibe Auth integration plan,
// rule I13). Boots the real API against a scratch Postgres database, a scratch
// Redis logical database and a fake OpenID provider (test/fake-idp.mjs), and
// walks the scenarios the plan names: status in local/both, PKCE login → JIT
// with the mapped role (and both session cookies), a CSRF-protected staff POST
// from an SSO session, existing-user email link + role sync, unverified email
// denied, /auth/settings 403/200 (+ CSRF on PUT), the oidc_only guard on
// /api/auth/login while portal + webhook routes still answer, break-glass
// CLI + local login + audit, back-channel logout ending the Redis session,
// fresh login afterwards, RP-initiated logout, boot refusal without break-glass.
//
//   pnpm test:sso-e2e
//
// Prerequisites: the dev compose Postgres + Redis
// (docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis)
// and pnpm install done.
//   E2E_PG_ADMIN_URL   admin connection (default: the compose dev instance on :55432)
//   E2E_REDIS_URL      redis url (default: redis://127.0.0.1:56379/9 — FLUSHED per run)
//   E2E_KEEP_DB=1      leave the scratch database behind for inspection
//   E2E_VERBOSE=1      stream the api's output instead of buffering it
//
// Design notes:
//   - Mode changes are RESTARTS. A successful PUT /auth/settings {mode} is
//     persisted and overrides VIBE_AUTH_MODE for every later boot, which would
//     silently break the boot-refusal scenario. The only PUTs here are refused
//     before anything is stored.
//   - The port is chosen by this script, not the child: VIBE_OIDC_PUBLIC_URL
//     (and so the redirect URI registered with the IdP) is baked in at boot.
//   - The env is a whitelist; the api's `start` script reads no .env file.
//   - Sessions are Redis-backed, so back-channel logout is immediate (no
//     revocation list, no iat granularity to wait out).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { FakeIdp } from './fake-idp.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const requireDb = createRequire(realpathSync(path.join(ROOT, 'packages/db/package.json')));
const requireCore = createRequire(realpathSync(path.join(ROOT, 'packages/core/package.json')));
const { Client } = requireDb('pg');
const Redis = requireCore('ioredis').default ?? requireCore('ioredis');

const API_ENTRY = path.join('apps', 'api', 'src', 'index.ts');
const BOOTSTRAP = path.join('apps', 'api', 'src', 'ops', 'bootstrap-firm.ts');
// The very command the appliance console runs inside the image (from its WORKDIR).
const VIBE_CLI = path.join('apps', 'api', 'node_modules', '@kisaesdevlab', 'vibe-auth', 'dist', 'cli.js');
const VIBE_ADAPTER = path.join('apps', 'api', 'src', 'vibeAuthAdapter.ts');
const TSX_IMPORT = ['--import', 'tsx']; // tsx is a root devDependency; resolved from cwd = ROOT

const ADMIN_URL = process.env.E2E_PG_ADMIN_URL ?? 'postgres://vibe1099:vibe1099@127.0.0.1:55432/postgres';
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:56379/9';
const VERBOSE = process.env.E2E_VERBOSE === '1';
const KEEP_DB = process.env.E2E_KEEP_DB === '1';

const CLIENT_ID = 'vibe-1099-e2e';
const CLIENT_SECRET = 's3cret';
const MASTER_KEY = randomBytes(32).toString('base64');
const ADMIN_EMAIL = 'admin@e2e.firm';
const ADMIN_PASSWORD = 'E2eAdmin!2026xyz';
const PAT_PASSWORD = 'E2ePat!2026xyz';
const BREAKGLASS_EMAIL = 'vibe-breakglass@vibe-1099.local';
const BREAKGLASS_PASSWORD = 'E2eBreakGlass!2026';

const KURT = { sub: 'u-100', email: 'kurt@kisaes.com', email_verified: true, name: 'Kurt', groups: ['vibe-partner'], amr: ['pwd', 'otp'] };
const PAT_IDP = { sub: 'u-200', email: 'pat@kisaes.com', email_verified: true, name: 'Pat', groups: ['vibe-manager'] };
const NOBODY = { sub: 'u-300', email: 'nobody@kisaes.com', email_verified: false, groups: ['vibe-partner'] };

// ─────────────────────────────────────────────────────────────── plumbing

const t0 = Date.now();
const log = (line) => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${line}`);

class Ring {
  lines = [];
  push(prefix, chunk) {
    for (const l of String(chunk).split(/\r?\n/)) {
      if (!l) continue;
      const line = `${prefix} ${l}`;
      if (VERBOSE) console.log(line);
      this.lines.push(line);
      if (this.lines.length > 400) this.lines.shift();
    }
  }
  dump() {
    if (this.lines.length) console.error(this.lines.slice(-200).join('\n'));
  }
}
const output = new Ring();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Whitelisted environment for every child: nothing from the developer's shell leaks in. */
function childEnv(extra) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'NODE_OPTIONS'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

function run(cmd, args, { cwd, env, prefix }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; output.push(prefix, c); });
    child.stderr.on('data', (c) => { stderr += c; output.push(prefix, c); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function killTree(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────── database / redis

let admin;      // pg client on the maintenance db
let dbc;        // pg client on the scratch db
let dbName;
let dbUrl;
let redis;

async function createScratchDb() {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const stale = await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE 'vibe1099_sso_e2e_%'`);
  for (const r of stale.rows) {
    log(`dropping leftover ${r.datname}`);
    await admin.query(`DROP DATABASE "${r.datname}" WITH (FORCE)`);
  }
  dbName = `vibe1099_sso_e2e_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  dbUrl = u.toString();
  log(`created ${dbName}`);

  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  await redis.flushdb();
  log(`flushed ${REDIS_URL}`);
}

async function dropScratchDb() {
  if (dbc) { await dbc.end().catch(() => {}); dbc = null; }
  if (redis) { await redis.flushdb().catch(() => {}); redis.disconnect(); redis = null; }
  if (admin && dbName && !KEEP_DB) {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch((e) => console.error('drop failed:', e.message));
    log(`dropped ${dbName}`);
  } else if (KEEP_DB) log(`kept ${dbName} (E2E_KEEP_DB=1)`);
  if (admin) { await admin.end().catch(() => {}); admin = null; }
}

const sql = async (text, params = []) => (await dbc.query(text, params)).rows;

async function auditActions() {
  return (await sql(`SELECT action, entity_id, detail FROM audit_log WHERE entity_type = 'auth' ORDER BY id`))
    .map((r) => ({ action: r.action, entityId: r.entity_id, detail: r.detail ?? {} }));
}
const hasAudit = (rows, action, pred = () => true) => rows.some((r) => r.action === action && pred(r));

async function redisSessionsFor(userId) {
  const keys = await redis.keys('sess:*');
  let n = 0;
  for (const k of keys) {
    const raw = await redis.get(k);
    if (raw && JSON.parse(raw).userId === userId) n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────── api process

let idp;
let server = null; // { child, port, base, mode }

function baseEnv() {
  return childEnv({
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    MASTER_KEY,
    DATABASE_URL: dbUrl,
    REDIS_URL,
    RENDER_URL: 'http://127.0.0.1:9', // never called here
    TRUST_PROXY_HOPS: '0',
    VIBE_BREAKGLASS_USERNAME: 'vibe-breakglass',
  });
}

function serverEnv(mode, port) {
  return {
    ...baseEnv(),
    API_PORT: String(port),
    APP_BASE_URL: `http://127.0.0.1:${port}`,
    PORTAL_BASE_URL: `http://127.0.0.1:${port}`,
    VIBE_AUTH_MODE: mode,
    VIBE_OIDC_ISSUER: idp.issuer,
    VIBE_OIDC_CLIENT_ID: CLIENT_ID,
    VIBE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    VIBE_OIDC_PUBLIC_URL: `http://127.0.0.1:${port}`,
  };
}

/** Boot the api in `mode`; resolves once /api/health answers (and, for SSO modes, the IdP is discovered). */
async function startServer(mode) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [...TSX_IMPORT, API_ENTRY], {
    cwd: ROOT, env: serverEnv(mode, port), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (c) => output.push(`[api:${mode}]`, c));
  child.stderr.on('data', (c) => output.push(`[api:${mode}]`, c));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  const deadline = Date.now() + 45_000;
  let healthy = false;
  while (Date.now() < deadline) {
    const code = await Promise.race([exited, sleep(150).then(() => null)]);
    if (code !== null) throw new Error(`api (${mode}) exited with code ${code} before becoming healthy`);
    healthy = await fetch(`${base}/api/health`).then((r) => r.status === 200).catch(() => false);
    if (healthy) break;
  }
  if (!healthy) { await killTree(child); throw new Error(`api (${mode}) did not become healthy in 45 s`); }
  if (mode !== 'local') {
    const until = Date.now() + 15_000;
    for (;;) {
      const s = await fetch(`${base}/auth/status`).then((r) => r.json()).catch(() => null);
      if (s?.oidc?.reachable) break;
      if (Date.now() > until) throw new Error(`IdP not reachable from the api: ${JSON.stringify(s)}`);
      await sleep(150);
    }
  }
  server = { child, port, base, mode };
  log(`api up (${mode}) on ${base}`);
  return server;
}

/** Boot in `mode` and expect the process to refuse; returns {code, out}. */
async function startServerExpectingRefusal(mode) {
  const port = await freePort();
  let out = '';
  const child = spawn(process.execPath, [...TSX_IMPORT, API_ENTRY], {
    cwd: ROOT, env: serverEnv(mode, port), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (c) => { out += c; output.push(`[api:${mode}]`, c); });
  child.stderr.on('data', (c) => { out += c; output.push(`[api:${mode}]`, c); });
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', (c) => resolve(c))),
    sleep(45_000).then(() => 'timeout'),
  ]);
  if (code === 'timeout') { await killTree(child); throw new Error(`api (${mode}) did not exit within 45 s`); }
  return { code, out };
}

async function stopServer() {
  if (!server) return;
  await killTree(server.child);
  log(`api stopped (${server.mode})`);
  server = null;
}

// ─────────────────────────────────────────────────────────────── http helpers (cookie jar per "browser")

class Browser {
  cookies = new Map();
  absorb(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*(max-age=0|expires=Thu, 01 Jan 1970)/i.test(a));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get sid() { return this.cookies.get('v1099_sid'); }
  get csrf() { return this.cookies.get('v1099_csrf'); }
}

async function api(p, { method = 'GET', browser, json, form, headers = {}, csrf = true } = {}) {
  const h = { ...headers };
  if (browser?.cookies.size) h.cookie = browser.header();
  if (browser && csrf && !['GET', 'HEAD'].includes(method) && browser.csrf && h['x-csrf-token'] === undefined) h['x-csrf-token'] = browser.csrf;
  let body;
  if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const res = await fetch(server.base + p, { method, headers: h, body, redirect: 'manual' });
  browser?.absorb(res);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, headers: res.headers, location: res.headers.get('location') ?? '', text, json: data, contentType: res.headers.get('content-type') ?? '' };
}

/** Follow /auth/oidc/start → IdP (auto-consent) → callback with a fresh browser; returns the final hop + browser. */
async function ssoLogin({ returnTo, browser = new Browser() } = {}) {
  let url = server.base + '/auth/oidc/start' + (returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '');
  for (let hop = 0; hop < 8; hop++) {
    const isOurs = url.startsWith(server.base);
    const res = await fetch(url, { redirect: 'manual', headers: isOurs && browser.cookies.size ? { cookie: browser.header() } : {} });
    if (isOurs) browser.absorb(res);
    const location = res.headers.get('location') ?? '';
    if (res.status >= 300 && res.status < 400 && location) {
      if (url.includes('/auth/oidc/callback')) {
        return { status: res.status, location, browser, text: '', contentType: '' };
      }
      url = new URL(location, url).toString();
      continue;
    }
    const text = await res.text();
    return { status: res.status, location, browser, text, contentType: res.headers.get('content-type') ?? '' };
  }
  throw new Error('login redirect chain did not terminate');
}

async function localLogin(email, password, browser = new Browser()) {
  const r = await api('/api/auth/login', { method: 'POST', browser, json: { email, password }, csrf: false });
  return { ...r, browser };
}

async function breakglassCli(...args) {
  const r = await run(process.execPath, [...TSX_IMPORT, VIBE_CLI, 'breakglass', ...args, '--json'], {
    cwd: ROOT,
    env: { ...baseEnv(), VIBE_AUTH_ADAPTER: VIBE_ADAPTER, VIBE_BREAKGLASS_PASSWORD: BREAKGLASS_PASSWORD },
    prefix: '[cli]',
  });
  assert.equal(r.code, 0, `breakglass ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
  const line = r.stdout.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
  assert.ok(line, `breakglass ${args.join(' ')} printed no JSON: ${r.stdout}`);
  return JSON.parse(line);
}

// ─────────────────────────────────────────────────────────────── scenarios

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    log(`ok   ${name}`);
  } catch (err) {
    log(`FAIL ${name}`);
    throw err;
  }
}

async function main() {
  await createScratchDb();

  // Real firm + first admin, the way the appliance seeds production (runs migrations too).
  const boot = await run(process.execPath, [...TSX_IMPORT, BOOTSTRAP], {
    cwd: ROOT,
    env: { ...baseEnv(), FIRM_NAME: 'E2E Firm', VIBE1099_ADMIN_EMAIL: ADMIN_EMAIL, VIBE1099_ADMIN_PASSWORD: ADMIN_PASSWORD },
    prefix: '[bootstrap]',
  });
  assert.equal(boot.code, 0, `bootstrap-firm failed: ${boot.stderr || boot.stdout}`);

  dbc = new Client({ connectionString: dbUrl });
  await dbc.connect();
  for (const t of ['auth_identities', 'auth_settings', 'auth_revocations', 'auth_sessions_oidc']) {
    assert.equal((await sql(`SELECT to_regclass($1)::text AS t`, [t]))[0].t, t, `migration did not create ${t}`);
  }

  idp = await new FakeIdp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, user: KURT }).start();
  log(`fake IdP at ${idp.issuer}`);

  let adminBrowser;
  let patBrowser;
  let patId;

  // ── Boot A: local ─────────────────────────────────────────────────────
  await startServer('local');

  await step('1. status in local mode: SSO off, local login visible, start refused; password login sets both cookies', async () => {
    const s = await api('/auth/status');
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.mode, 'local');
    assert.equal(s.json.oidc.enabled, false);
    assert.equal(s.json.localLoginVisible, true);
    assert.equal(s.json.breakglassPath, '/login/local');
    assert.equal((await api('/auth/oidc/start')).status, 409);
    const login = await localLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
    assert.equal(login.status, 200, login.text);
    adminBrowser = login.browser;
    assert.ok(adminBrowser.sid && adminBrowser.csrf, 'v1099_sid + v1099_csrf expected');
    const me = await api('/api/auth/me', { browser: adminBrowser });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.user.role, 'admin');
    assert.ok(!me.json.user.sso, 'password session must not be flagged sso');
  });

  await step('fixtures: create a preparer through the CSRF-protected staff API', async () => {
    const create = await api('/api/auth/users', { method: 'POST', browser: adminBrowser, json: { email: PAT_IDP.email, name: 'Pat', role: 'preparer', password: PAT_PASSWORD } });
    assert.equal(create.status, 201, create.text);
    patId = create.json.id;
    const pl = await localLogin(PAT_IDP.email, PAT_PASSWORD);
    assert.equal(pl.status, 200, pl.text);
    patBrowser = pl.browser;
  });

  await step('5. /auth/settings is 403 anonymous and for a preparer, 200 for an admin; PUT needs the CSRF header', async () => {
    assert.equal((await api('/auth/settings')).status, 403);
    assert.equal((await api('/auth/settings', { browser: patBrowser })).status, 403);
    const r = await api('/auth/settings', { browser: adminBrowser });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.mode, 'local');
    assert.equal(r.json.breakglass?.exists, false);
    assert.equal(r.json.effective?.redirectUri, `${server.base}/auth/oidc/callback`);
    const noCsrf = await api('/auth/settings', { method: 'PUT', browser: adminBrowser, json: { mode: 'both' }, csrf: false });
    assert.equal(noCsrf.status, 403, `PUT without x-csrf-token must be refused: ${noCsrf.text}`);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_settings'))[0].n, 0, 'a refused PUT must persist nothing');
  });

  await step('6. oidc_only cannot be enabled from Settings without break-glass + a fresh test connection', async () => {
    const r = await api('/auth/settings', { method: 'PUT', browser: adminBrowser, json: { mode: 'oidc_only' } });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error, 'validation_failed');
    const errs = r.json.errors.join(' ');
    assert.match(errs, /break-glass/);
    assert.match(errs, /Test connection/);
    assert.equal((await api('/auth/settings', { method: 'PUT', browser: patBrowser, json: { mode: 'oidc_only' } })).status, 403);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_settings'))[0].n, 0, 'a refused PUT must persist nothing');
    assert.ok(!hasAudit(await auditActions(), 'vibe.auth.mode.changed'));
  });

  await stopServer();

  // ── Boot B: oidc_only without break-glass ─────────────────────────────
  await step('11. boot is refused in oidc_only mode while no break-glass user exists', async () => {
    const { code, out } = await startServerExpectingRefusal('oidc_only');
    assert.equal(code, 1);
    assert.match(out, /break-glass user \\?"vibe-breakglass\\?" does not exist/); // pino JSON-escapes the quotes
    assert.equal((await sql(`SELECT count(*)::int AS n FROM users WHERE email = $1`, [BREAKGLASS_EMAIL]))[0].n, 0);
  });

  // ── Boot C: both ──────────────────────────────────────────────────────
  await startServer('both');
  let kurtId;

  await step('2. status in both mode: SSO enabled and reachable; public zone still answers', async () => {
    const s = (await api('/auth/status')).json;
    assert.equal(s.mode, 'both');
    assert.equal(s.oidc.enabled, true);
    assert.equal(s.oidc.reachable, true);
    assert.equal(s.oidc.issuer, idp.issuer);
    assert.equal(s.oidc.startPath, '/auth/oidc/start');
    assert.equal(s.localLoginVisible, true);
    const hook = await api('/api/webhooks/taxbandits');
    assert.equal(hook.status, 200, 'TaxBandits webhook probe must still be reachable (mount order)');
    assert.equal(hook.json.service, 'vibe1099-taxbandits-webhook');
  });

  await step('3. PKCE login provisions a new user with the mapped role, sets both cookies, and the session works with CSRF', async () => {
    idp.user = KURT;
    const r = await ssoLogin();
    assert.equal(r.status, 302, r.text);
    assert.equal(r.location, '/');
    assert.ok(r.browser.sid, 'no v1099_sid cookie after the callback');
    assert.ok(r.browser.csrf, 'no v1099_csrf cookie after the callback');
    assert.ok(idp.tokenRequests.at(-1).get('code_verifier'), 'PKCE verifier not sent');
    const [u] = await sql(`SELECT id, role, active, name, firm_id FROM users WHERE email = $1`, [KURT.email]);
    assert.ok(u, 'JIT user missing');
    kurtId = u.id;
    assert.equal(u.role, 'admin', 'vibe-partner must map to admin');
    assert.equal(u.active, true);
    assert.equal(u.name, 'Kurt');
    assert.equal(u.firm_id, (await sql('SELECT id FROM firms ORDER BY created_at LIMIT 1'))[0].id, 'JIT user joins the sole firm');
    const me = await api('/api/auth/me', { browser: r.browser });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.user.userId, kurtId);
    assert.equal(me.json.user.role, 'admin');
    assert.equal(me.json.user.sso, true, '/me must flag an SSO-born session');
    const [ident] = await sql(`SELECT user_id FROM auth_identities WHERE issuer = $1 AND subject = $2`, [idp.issuer, KURT.sub]);
    assert.equal(ident?.user_id, kurtId);
    const sess = await sql(`SELECT oidc_sid, id_token, sid_hash FROM auth_sessions_oidc WHERE user_id = $1`, [kurtId]);
    assert.equal(sess.length, 1);
    assert.equal(sess[0].oidc_sid, 'sid-' + KURT.sub);
    assert.ok(sess[0].id_token);
    assert.notEqual(sess[0].sid_hash, r.browser.sid, 'the raw session id must not be stored');
    const audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.user.provisioned', (a) => a.entityId === kurtId), 'no provisioned audit row');
    assert.ok(hasAudit(audit, 'vibe.auth.login.success', (a) => a.entityId === kurtId), 'no login.success audit row');
    // A staff mutation from the SSO session with the csrf token read off the cookie.
    const post = await api('/api/auth/users', { method: 'POST', browser: r.browser, json: { email: 'temp@e2e.firm', name: 'Temp', role: 'preparer', password: 'TempPassw0rd!xyz' } });
    assert.equal(post.status, 201, post.text);
    const noCsrf = await api('/api/auth/users', { method: 'POST', browser: r.browser, json: { email: 'temp2@e2e.firm', name: 'Temp', role: 'preparer', password: 'TempPassw0rd!xyz' }, csrf: false });
    assert.equal(noCsrf.status, 403);
    const back = await ssoLogin({ returnTo: '/settings' });
    assert.equal(back.location, '/settings');
  });

  await step('4. an existing local user is linked by verified email and the role is synced from the group', async () => {
    idp.user = PAT_IDP;
    const before = (await sql('SELECT count(*)::int AS n FROM users'))[0].n;
    const r = await ssoLogin();
    assert.equal(r.status, 302, r.text);
    const me = await api('/api/auth/me', { browser: r.browser });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.user.userId, patId);
    assert.equal(me.json.user.role, 'reviewer', 'vibe-manager must map to reviewer');
    assert.equal((await sql('SELECT count(*)::int AS n FROM users'))[0].n, before, 'linking must not create a user');
    assert.equal((await sql('SELECT role FROM users WHERE id = $1', [patId]))[0].role, 'reviewer');
    const [ident] = await sql(`SELECT user_id FROM auth_identities WHERE issuer = $1 AND subject = $2`, [idp.issuer, PAT_IDP.sub]);
    assert.equal(ident?.user_id, patId);
    const audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.user.linked', (a) => a.entityId === patId));
    assert.ok(hasAudit(audit, 'vibe.auth.role.changed', (a) => a.entityId === patId && a.detail.from === 'preparer' && a.detail.to === 'reviewer'));
    patBrowser = r.browser;
    assert.equal((await api('/auth/settings', { browser: patBrowser })).status, 403, 'a reviewer still cannot read settings');
  });

  await step('9. an unverified email is denied and nothing is written', async () => {
    idp.user = NOBODY;
    const r = await ssoLogin();
    assert.equal(r.status, 401);
    assert.match(r.contentType, /text\/html/);
    assert.match(r.text, /did not confirm your email/);
    assert.ok(!r.browser.sid, 'no session for a denied login');
    assert.equal((await sql('SELECT count(*)::int AS n FROM users WHERE email = $1', [NOBODY.email]))[0].n, 0);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_identities WHERE subject = $1', [NOBODY.sub]))[0].n, 0);
    assert.ok(hasAudit(await auditActions(), 'vibe.auth.login.failure', (a) => a.detail.reason === 'unverified_email'));
    assert.equal((await api('/auth/oidc/callback?code=x&state=nope')).status, 400, 'unknown state must be refused');
  });

  await step('10. RP-initiated logout ends the Redis session and sends the browser to the IdP; ?local=1 lands on /login', async () => {
    idp.user = KURT;
    const login = await ssoLogin();
    assert.equal((await api('/api/auth/me', { browser: login.browser })).status, 200);
    const rowsBefore = (await sql('SELECT count(*)::int AS n FROM auth_sessions_oidc WHERE user_id = $1', [kurtId]))[0].n;
    const r = await api('/auth/oidc/logout', { browser: login.browser });
    assert.equal(r.status, 302, r.text);
    const u = new URL(r.location);
    assert.equal(u.origin, idp.base);
    assert.match(u.pathname, /\/end-session\/$/);
    assert.ok(u.searchParams.get('id_token_hint'));
    assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(u.searchParams.get('post_logout_redirect_uri'), `${server.base}/auth/oidc/logged-out`);
    assert.ok(!login.browser.sid, 'session cookie must be cleared');
    // Only THIS browser's identity row goes; Kurt's other sessions (step 3) stay signed in.
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_sessions_oidc WHERE user_id = $1', [kurtId]))[0].n, rowsBefore - 1);
    assert.ok(hasAudit(await auditActions(), 'vibe.auth.logout', (a) => a.detail.initiated_by === 'user'));
    const idpHop = await fetch(u.toString(), { redirect: 'manual' });
    assert.equal(idpHop.status, 302);
    const done = await fetch(idpHop.headers.get('location'), { redirect: 'manual' });
    assert.equal(done.status, 200);
    assert.match(done.headers.get('content-type') ?? '', /text\/html/);
    // Local-only sign-out (what the SPA's Sign out button does) keeps the provider session.
    const again = await ssoLogin();
    const local = await api('/auth/oidc/logout?local=1', { browser: again.browser });
    assert.equal(local.status, 302);
    assert.equal(local.location, '/login');
    assert.equal((await api('/api/auth/me', { browser: again.browser })).status, 401);
  });

  await step('8. back-channel logout ends every Redis session of the user, once; other users keep theirs', async () => {
    idp.user = KURT;
    const a = await ssoLogin();
    const b = await ssoLogin();
    const pw = await localLogin(KURT.email, 'not-the-password'); // a local attempt does not matter; use the admin instead
    assert.equal(pw.status, 401);
    assert.equal((await api('/api/auth/me', { browser: a.browser })).status, 200);
    assert.equal((await api('/api/auth/me', { browser: b.browser })).status, 200);
    assert.ok((await redisSessionsFor(kurtId)) >= 2, 'expected the two fresh sessions (plus any from earlier steps)');
    const logoutToken = await idp.logoutToken({ sub: KURT.sub, sid: 'sid-' + KURT.sub });
    const r = await api('/auth/oidc/backchannel', { method: 'POST', form: { logout_token: logoutToken } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_sessions_oidc WHERE user_id = $1', [kurtId]))[0].n, 0);
    assert.equal(await redisSessionsFor(kurtId), 0, 'every Redis session of the user must be gone');
    assert.equal((await api('/api/auth/me', { browser: a.browser })).status, 401);
    assert.equal((await api('/api/auth/me', { browser: b.browser })).status, 401);
    const replay = await api('/auth/oidc/backchannel', { method: 'POST', form: { logout_token: logoutToken } });
    assert.equal(replay.status, 400, 'a replayed logout token must be refused');
    assert.equal((await api('/api/auth/me', { browser: patBrowser })).status, 200, 'logout is per user');
    assert.equal((await api('/api/auth/me', { browser: adminBrowser })).status, 200, 'local sessions of other users survive');
    assert.ok(hasAudit(await auditActions(), 'vibe.auth.logout', (a) => a.detail.initiated_by === 'idp'));
  });

  await step("9'. a fresh login right after the back-channel logout is valid (no revocation list needed)", async () => {
    idp.user = KURT;
    const login = await ssoLogin();
    assert.equal((await api('/api/auth/me', { browser: login.browser })).status, 200);
  });

  await step('7. the break-glass CLI (the image command) provisions an admin who can sign in locally; both are audited', async () => {
    const created = await breakglassCli('ensure');
    assert.equal(created.status, 'created', JSON.stringify(created));
    assert.equal(created.username, 'vibe-breakglass');
    const [bg] = await sql(`SELECT id, role, active, totp_enabled, email FROM users WHERE email = $1`, [BREAKGLASS_EMAIL]);
    assert.ok(bg, 'break-glass user row missing');
    assert.equal(bg.role, 'admin');
    assert.equal(bg.active, true);
    assert.equal(bg.totp_enabled, false);
    let audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.breakglass.rotated'), 'no breakglass.rotated audit row');
    const login = await localLogin(BREAKGLASS_EMAIL, BREAKGLASS_PASSWORD);
    assert.equal(login.status, 200, login.text);
    audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.breakglass.used', (a) => a.entityId === bg.id), 'no breakglass.used audit row');
    const me = await api('/api/auth/me', { browser: login.browser });
    assert.equal(me.json.user.role, 'admin');
    assert.ok(!me.json.user.sso);
    const again = await breakglassCli('ensure');
    assert.equal(again.status, 'exists', 'ensure must be idempotent');
    const st = await breakglassCli('status');
    assert.equal(st.exists, true);
    assert.equal(st.active, true);
    assert.equal(st.role, 'admin');
    const settings = await api('/auth/settings', { browser: login.browser });
    assert.equal(settings.status, 200, settings.text);
    assert.equal(settings.json.breakglass.exists, true);
  });

  await stopServer();

  // ── Boot D: oidc_only with break-glass ────────────────────────────────
  await startServer('oidc_only');
  await step('oidc_only: only the break-glass admin may use a password; SSO start, portals and webhooks still answer', async () => {
    const s = (await api('/auth/status')).json;
    assert.equal(s.mode, 'oidc_only');
    assert.equal(s.localLoginVisible, false);
    const refused = await localLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.error.code, 'E_FORBIDDEN');
    assert.equal(refused.json.error.details?.localLoginDisabled, true);
    const bg = await localLogin(BREAKGLASS_EMAIL, BREAKGLASS_PASSWORD);
    assert.equal(bg.status, 200, bg.text);
    assert.equal((await api('/auth/oidc/start')).status, 302);
    // Recipient / client / W-9 portals and the provider webhook are untouched (I11 + mount order).
    assert.equal((await api('/api/webhooks/taxbandits')).status, 200);
    for (const p of ['/api/portal/not-a-token', '/api/client-portal/me', '/api/w9-public/not-a-token']) {
      const r = await api(p);
      assert.ok(r.status === 401 || r.status === 404 || r.status === 400, `${p} → ${r.status} (${r.text.slice(0, 80)})`);
      assert.notEqual(r.json?.error?.code, 'E_FORBIDDEN', `${p} must not be blocked by the SSO policy`);
    }
  });
  await stopServer();
}

// ─────────────────────────────────────────────────────────────── lifecycle

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await stopServer().catch(() => {});
  if (idp) await idp.stop().catch(() => {});
  await dropScratchDb().catch((e) => console.error('cleanup:', e.message));
}

process.on('exit', (code) => { process.stderr.write(`sso-e2e: exiting with code ${code} after ${passed} passed steps\n`); });

const watchdog = setTimeout(() => {
  console.error('sso-e2e: watchdog fired after 300 s');
  output.dump();
  cleanup().finally(() => process.exit(1));
}, 300_000);
watchdog.unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup().finally(() => process.exit(1)); });
}

// Let stdout drain before leaving (process.exit right after console.log can drop
// the last lines when stdout is a pipe). Everything is closed by cleanup().
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}

main()
  .then(async () => {
    await cleanup();
    log(`sso-e2e: ${passed} steps passed`);
    finish(0);
  })
  .catch(async (err) => {
    console.error('\nsso-e2e FAILED:', err && err.stack ? err.stack : err);
    output.dump();
    await cleanup();
    finish(1);
  });
