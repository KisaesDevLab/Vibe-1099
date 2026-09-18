// In-process fake OpenID Provider for test/sso-e2e.mjs (Vibe 1099).
//
// A type-erased port of Vibe-Auth/packages/client/test/fake-idp.ts (package
// @kisaesdevlab/vibe-auth 1.0.1, repo commit 063a6d8). The published package
// ships only dist/ and sql/, so the fake provider has to live here; keep the
// behaviour identical to the upstream file when re-syncing. It implements
// discovery, JWKS, authorization (auto-consents the configured user), token
// (PKCE S256 + client_secret_basic), userinfo, end-session, and can mint
// back-channel logout tokens.
//
// `jose` is loaded through @kisaesdevlab/vibe-auth's own dependency tree (this
// directory has no dependencies of its own).

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// pnpm installs the package as a symlink; require() from its REAL path so jose resolves.
const require = createRequire(realpathSync(fileURLToPath(new URL('../apps/api/node_modules/@kisaesdevlab/vibe-auth/package.json', import.meta.url))));
const { exportJWK, generateKeyPair, SignJWT } = require('jose');

export class FakeIdp {
  server = null;
  port = 0;
  #priv = null;
  #pub = null;
  #kid = 'test-key';
  #codes = new Map();
  #accessTokens = new Map(); // token → sub
  user;
  opts;
  tokenRequests = [];
  issuerOverride;

  /** @param {{ issuer?: string, clientId: string, clientSecret?: string, user: object, denyWith?: string }} opts */
  constructor(opts) {
    this.opts = opts;
    this.user = opts.user;
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }
  get issuer() {
    return (this.issuerOverride ?? this.opts.issuer ?? this.base + '/application/o/test/').replace(/\/+$/, '') + '/';
  }

  async start() {
    const kp = await generateKeyPair('RS256');
    this.#priv = kp.privateKey;
    this.#pub = kp.publicKey;
    this.server = createServer((req, res) => void this.#handle(req, res));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    return this;
  }

  async stop() {
    // Keep-alive sockets from the app's discovery/JWKS fetches would otherwise
    // hold close() open until they time out.
    this.server.closeAllConnections?.();
    await new Promise((r) => this.server.close(() => r()));
  }

  async signIdToken(o) {
    const u = this.user;
    const claims = {
      email: u.email,
      email_verified: u.email_verified,
      name: u.name,
      groups: u.groups,
      roles: u.roles,
      amr: u.amr ?? ['pwd'],
      sid: o.sid ?? 'sid-' + u.sub,
      ...(o.nonce ? { nonce: o.nonce } : {}),
      ...(o.accessToken ? { at_hash: atHash(o.accessToken) } : {}),
      ...o.extra,
    };
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: this.#kid })
      .setIssuer(this.issuer)
      .setSubject(u.sub)
      .setAudience(o.aud ?? this.opts.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.#priv);
  }

  /** A back-channel logout token. `sub` is what reaches a product whose own session ids differ from the IdP's. */
  async logoutToken(o) {
    const j = new SignJWT({
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      ...(o.sid ? { sid: o.sid } : {}),
      ...(o.withNonce ? { nonce: 'x' } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: this.#kid })
      .setIssuer(this.issuer)
      .setAudience(o.aud ?? this.opts.clientId)
      .setIssuedAt()
      .setJti(randomUUID());
    if (o.sub) j.setSubject(o.sub);
    return j.sign(this.#priv);
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', this.base);
    const path = url.pathname;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (path.endsWith('/.well-known/openid-configuration')) {
      const iss = this.issuer;
      return send(200, {
        issuer: iss,
        authorization_endpoint: `${iss}authorize/`,
        token_endpoint: `${iss}token/`,
        userinfo_endpoint: `${iss}userinfo/`,
        jwks_uri: `${iss}jwks/`,
        end_session_endpoint: `${iss}end-session/`,
        revocation_endpoint: `${iss}revoke/`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
        backchannel_logout_supported: true,
        backchannel_logout_session_supported: true,
      });
    }
    if (path.endsWith('/jwks/')) {
      const jwk = await exportJWK(this.#pub);
      return send(200, { keys: [{ ...jwk, kid: this.#kid, use: 'sig', alg: 'RS256' }] });
    }
    if (path.endsWith('/authorize/')) {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      const state = q.get('state') ?? '';
      const target = new URL(redirectUri);
      if (this.opts.denyWith) {
        target.searchParams.set('error', this.opts.denyWith);
        target.searchParams.set('state', state);
        res.writeHead(302, { location: target.toString() });
        return res.end();
      }
      if (q.get('client_id') !== this.opts.clientId) return send(400, { error: 'unauthorized_client' });
      if (q.get('code_challenge_method') !== 'S256') return send(400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
      const code = randomUUID();
      this.#codes.set(code, { redirectUri, nonce: q.get('nonce') ?? '', codeChallenge: q.get('code_challenge') ?? undefined, state });
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      res.writeHead(302, { location: target.toString() });
      return res.end();
    }
    if (path.endsWith('/token/') && req.method === 'POST') {
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      this.tokenRequests.push(form);
      const auth = req.headers.authorization;
      if (this.opts.clientSecret) {
        const expected =
          'Basic ' + Buffer.from(`${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`).toString('base64');
        if (auth !== expected) return send(401, { error: 'invalid_client' });
      }
      const code = form.get('code') ?? '';
      const pc = this.#codes.get(code);
      this.#codes.delete(code);
      if (!pc) return send(400, { error: 'invalid_grant' });
      if (pc.redirectUri !== form.get('redirect_uri')) return send(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (pc.codeChallenge) {
        const verifier = form.get('code_verifier') ?? '';
        const expect = b64url(createHash('sha256').update(verifier).digest());
        if (expect !== pc.codeChallenge) return send(400, { error: 'invalid_grant', error_description: 'pkce' });
      }
      const accessToken = 'at-' + randomUUID();
      this.#accessTokens.set(accessToken, this.user.sub);
      const idToken = await this.signIdToken({ nonce: pc.nonce, accessToken });
      return send(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken, scope: 'openid profile email' });
    }
    if (path.endsWith('/userinfo/')) {
      const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!this.#accessTokens.has(t)) return send(401, { error: 'invalid_token' });
      const u = this.user;
      return send(200, { sub: u.sub, email: u.email, email_verified: u.email_verified, name: u.name, groups: u.groups, roles: u.roles });
    }
    if (path.endsWith('/end-session/')) {
      const back = url.searchParams.get('post_logout_redirect_uri');
      res.writeHead(302, { location: back ?? '/' });
      return res.end();
    }
    send(404, { error: 'not_found', path });
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
}
function b64url(b) {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function atHash(accessToken) {
  const h = createHash('sha256').update(accessToken).digest();
  return b64url(h.subarray(0, 16));
}
