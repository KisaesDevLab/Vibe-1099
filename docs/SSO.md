# Single sign-on (Vibe Auth) — operator notes

Staff can sign in to Vibe 1099 through the firm's **Vibe Auth** identity provider. The app consumes it as a
generic OIDC client through `@kisaesdevlab/vibe-auth`, the shared Vibe client package: Authorization Code +
PKCE, just-in-time user provisioning, Vibe group → role mapping, back-channel logout, and a
Settings → **Authentication** tab. The package's routes live under `/auth/*` on the API; everything
1099-specific is in `apps/api/src/lib/vibeAuth.ts` (engine wiring, session adapter) and
`apps/api/src/lib/vibeAuthUsers.ts` (user adapter over `users`, audit sink).

**Only the staff realm is affected.** The recipient portal (`/f/:token`), the W-9 portal and the client
portal keep their capability tokens, OTP and last-4-TIN challenges exactly as before.

Sessions stay what they were: a Redis-backed `v1099_sid` cookie with the `v1099_csrf` double-submit token.
An SSO sign-in mints that same session (flagged `sso: true`, visible on `GET /api/auth/me`), so every
existing route, the CSRF check and the inactivity/absolute timeouts apply unchanged. Redis holds no identity
data: the issuer / subject / IdP session id behind an SSO session is parked in Postgres `auth_sessions_oidc`,
keyed by an HMAC of the session id, so RP-initiated and back-channel logout can find it.

## Modes

| Mode | Password sign-in | SSO button | Notes |
|---|---|---|---|
| `local` (default) | everyone | hidden | Behaviour before this feature. |
| `both` | everyone | shown | Recommended while rolling out. |
| `oidc_only` | **break-glass admin only** | shown | The API refuses to boot until the break-glass account exists. Local TOTP is bypassed for SSO sessions — set `VIBE_OIDC_REQUIRE_MFA_AMR=true` so the IdP's MFA stands in. |

Switch modes on Settings → Authentication (admins) or with `VIBE_AUTH_MODE`. Values saved on the settings
page are stored in `auth_settings` and **override the environment on every later boot**; the client secret is
wrapped with the `MASTER_KEY` envelope (the same AES-GCM that protects TINs and TOTP secrets). Turning on
`oidc_only` requires an existing break-glass account **and** a successful "Test connection" within the last
hour by the same admin.

## Environment

On the Vibe Appliance the console writes this block after `sudo vibe identity register vibe-1099`. Standalone
deployments put it in `.env` (every name is enumerated in `docker-compose.yml`, so a new one must be added
there too).

| Variable | Meaning |
|---|---|
| `VIBE_AUTH_MODE` | `local` \| `both` \| `oidc_only` (see above). |
| `VIBE_OIDC_ISSUER` | Issuer URL of the Vibe Auth broker's OIDC provider for this app. |
| `VIBE_OIDC_INTERNAL_BASE` | Container-to-container base for discovery/token/JWKS when the public issuer is not reachable from inside the stack. |
| `VIBE_OIDC_CLIENT_ID`, `VIBE_OIDC_CLIENT_SECRET` | From the registration. |
| `VIBE_OIDC_PUBLIC_URL` | Public origin of this app as the browser sees it (same scheme as `APP_BASE_URL`; LAN mode is `http://<ip>:5176`). The redirect URI the IdP sees is `<VIBE_OIDC_PUBLIC_URL>/auth/oidc/callback`. |
| `VIBE_OIDC_REQUIRE_MFA_AMR` | `true` = refuse SSO logins whose ID token carries no MFA `amr`. Recommended. |
| `VIBE_OIDC_ROLE_MAP` | JSON, IdP group → `admin` \| `reviewer` \| `preparer`. Default: `vibe-admin`/`vibe-it`/`vibe-partner` → admin, `vibe-manager` → reviewer, `vibe-staff` → preparer. |
| `VIBE_OIDC_DEFAULT_ROLE`, `VIBE_OIDC_ALLOW_JIT`, `VIBE_OIDC_IDP_NAME`, `VIBE_OIDC_SCOPES` | Package options; see the package README. |
| `VIBE_BREAKGLASS_USERNAME` | Username of the package's break-glass admin (default `vibe-breakglass`). |

Users provisioned just-in-time join the deployment's one firm (the row `pnpm bootstrap:firm` created) with an
unusable random password hash; an existing user with the same verified email is linked instead, and the role is
re-synced from the IdP groups on every login.

**SSO-only accounts cannot use "Forgot password?".** A just-in-time account is marked `users.sso_only_since`
and the self-service reset (`POST /api/auth/password-reset/request`) refuses it: a mailbox must not mint a local
credential for an account the identity provider created. The response is the same `{"ok":true}` an unknown
address gets (no enumeration); the refusal is an `audit_log` row `password.reset.refused`
(`detail.reason = sso_only | breakglass`). An admin can still deliberately give such an account a local password
(Settings → Users → Reset password), which clears the marker. A local account that was later *linked* to an
identity keeps its self-service reset.

**Role sync never removes the last admin.** If the IdP groups would demote an admin while no *other* active
admin exists in the firm (the break-glass account does not count), the role is kept, the sign-in proceeds as
admin and `vibe.auth.role.sync_refused` (`detail.reason = last_active_admin`) is audited. The package still
writes its own `vibe.auth.role.changed` row for that login — the `sync_refused` row right after it is the truth.
The same rule stops the only active admin from deactivating or demoting themselves in Settings → Users (`409`).

## Paths and proxies

The engine is created with `basePath: ""`. The Appliance's Caddy routes `/auth/*` to the api tier (manifest
matcher `auth`), the web image's nginx and the Vite dev server proxy `/auth/*` to the API unchanged, and the
public URL comes from `VIBE_OIDC_PUBLIC_URL`, never from a path prefix.

| Path | Purpose |
|---|---|
| `GET /auth/status` | Mode, IdP reachability, start path (public). |
| `GET /auth/oidc/start`, `/auth/oidc/callback` | Sign-in. Lands on `/` (or `?return_to=`). |
| `POST /auth/oidc/backchannel` | Back-channel logout from the IdP (container-to-container; exempt from `STAFF_IP_ALLOWLIST`). Ends **every** Redis session of the affected user. |
| `GET /auth/oidc/logout` | RP-initiated logout (ends the IdP session too). `?local=1` ends only the 1099 session — this is what the SPA's Sign out button does for SSO sessions. |
| `GET/PUT /auth/settings`, `POST /auth/settings/test` | Settings → Authentication API. Admin session **and** the `x-csrf-token` header on mutations. |
| `/login/local` | Hidden SPA route that keeps the password form visible in `oidc_only` mode (break-glass). |

`STAFF_IP_ALLOWLIST`, when set, gates the browser-facing `/auth/*` routes exactly like the staff API.

## Break-glass account

A local admin that works with the identity provider down, stored as `vibe-breakglass@vibe-1099.local`
(`users` has no username column; `@localhost` would fail the email validator). Every use writes
`vibe.auth.breakglass.used` to the audit log.

- **Signing in:** on `/login/local` (or the normal form in `local`/`both`), type either the bare username
  **`vibe-breakglass`** — all the Appliance prints — or the full address `vibe-breakglass@vibe-1099.local`, plus
  the password. The username is case-insensitive and follows `VIBE_BREAKGLASS_USERNAME`; only the login form
  accepts it, every other email field stays a strict email.
- **Protected, in every mode:** Settings → Users cannot deactivate it, demote it from admin or change its email
  (`403 E_BREAKGLASS_PROTECTED`, audited as `user.update.refused`) — `oidc_only` refuses to boot without it and
  the CLI finds it by that address. Renaming it and an admin "Reset password" are allowed. "Forgot password?"
  never works for it; rotate the password with `vibe identity rotate-breakglass` on the Appliance
  (`pnpm vibe-auth breakglass rotate` standalone). Role sync never demotes it either.
- **Password-only by design.** Local MFA is per-user opt-in TOTP and the CLI cannot enrol one, so a freshly
  provisioned break-glass account has no second factor. If the firm's policy requires MFA on every admin
  credential, sign in as break-glass once at provisioning and enrol TOTP (Settings → Firm & printing →
  "Set up TOTP two-factor"), and keep the authenticator seed with the sealed password. Note that `rotate`
  changes the password only, not the TOTP seed.
- **"Break-glass ready" on the Appliance console only means a password is stored** for the account. It does not
  prove the account is active, that the stored password still matches (an admin reset here changes it without
  the Appliance knowing) or that anyone has tested the sign-in. `pnpm vibe-auth breakglass status` reports
  exists / active / role; test a real sign-in after provisioning.

```bash
pnpm vibe-auth breakglass ensure    # creates it, prints the password ONCE (or set VIBE_BREAKGLASS_PASSWORD)
pnpm vibe-auth breakglass rotate
pnpm vibe-auth breakglass status
```

Locally that runs `tsx node_modules/@kisaesdevlab/vibe-auth/dist/cli.js` from `apps/api`, whose `package.json`
names the adapter (`"vibeAuth": { "adapter": "./src/vibeAuthAdapter.ts" }`); it needs the API's `DATABASE_URL`
and `MASTER_KEY` in the environment (`node --env-file=.env` or the shell). Inside the image the console runs,
from `/app`:

```bash
node --import tsx apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass ensure --json
```

(`VIBE_AUTH_ADAPTER=/app/apps/api/src/vibeAuthAdapter.ts` is set by `Dockerfile.node`.) `ensure` is
idempotent; an inactive account is reactivated with a fresh password.

## Registering with the Vibe Auth broker

The Appliance console does this from `.appliance/manifest.json` (`requires: ["identity"]`, the `sso` block, the
`/auth/*` matcher). After changing the `sso` block, re-register with `sudo vibe identity register vibe-1099`;
a rebuilt image alone does not. By hand it is one call to the broker:

```http
POST /vibe-auth/registrations
{
  "slug": "vibe-1099",
  "name": "Vibe 1099",
  "baseUrl": "http://192.168.68.50:5176",
  "internalUrl": "http://vibe1099-app:8210",
  "redirectPaths": ["/auth/oidc/callback"],
  "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/api/health", "/api/about", "/api/status", "/api/portal/*", "/api/w9-public/*", "/api/client-portal/*",
                  "/api/webhooks/taxbandits", "/api/auth/login", "/api/auth/password-reset/*", "/f/*", "/w9/*", "/client", "/client/*", "/login/local"]
}
```

`internalUrl` must reach the api container: back-channel logout is delivered container-to-container.

## Building from source

`@kisaesdevlab/vibe-auth` is served from GitHub Packages. `pnpm install` needs a token with `read:packages` in
`~/.npmrc`:

```
//npm.pkg.github.com/:_authToken=<token>     # e.g. $(gh auth token)
```

Docker builds take it as a BuildKit secret that never lands in a layer:

```bash
export NODE_AUTH_TOKEN="$(gh auth token)"
docker compose build            # or: docker build --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -f Dockerfile.node .
```

CI and the release workflow use `GITHUB_TOKEN`; the Vibe-Auth package must grant this repository Actions
access (Vibe-Auth → Packages → vibe-auth → *Manage Actions access*). Pulling the published images needs nothing.

## Migration, audit, tests

- `packages/db/migrations/0013_vibe_auth.sql` creates `auth_identities`, `auth_settings`, `auth_revocations`
  (the package's shipped SQL, verbatim; the revocation list is unused by a Redis-session product) and
  `auth_sessions_oidc`. Applied on boot like every migration.
- `packages/db/migrations/0014_users_sso_only_since.sql` adds `users.sso_only_since` (NULL = the account has or
  had a local password; set when Vibe Auth provisions the account, cleared when an admin or the break-glass CLI
  sets a password). `password_hash` is NOT NULL and a JIT hash is just unmatchable, so nothing else on the row
  carries that fact. Accounts provisioned before the column existed are backfilled from the append-only
  `audit_log` (`vibe.auth.user.provisioned` with no later `user.reset-password` / `password.reset.complete`).
- Every package event is one `audit_log` row: `actor_type = 'system'`, `action = vibe.auth.*`,
  `entity_type = 'auth'`, `entity_id = user id` when the event has one, `detail = the event payload`.
- `pnpm test:sso-e2e` boots the real API against a scratch database + Redis db 9 and the fake IdP in
  `test/fake-idp.mjs` and walks the scenarios of the integration plan plus the hardening ones (break-glass by
  username, break-glass protection, reset refusal, last-admin role sync, sole-admin self-lockout;
  `.github/workflows/sso-e2e.yml` runs it on every PR).

## Deviations from the Vibe-Auth integration plan (`Vibe-Auth/docs/integration-plans/vibe-1099.md`)

- `/auth/*` is mounted on the app (outside the staff router) so the back-channel POST can bypass the IP
  allowlist; browser-facing `/auth/*` still sits behind it. The plan's line reference pointed inside the staff router.
- The local-login guard is inlined in `POST /api/auth/login` (after rate limit and lockout) so the product's
  error envelope (`E_FORBIDDEN`, `details.localLoginDisabled`) is preserved, instead of the package's `guardLocalLogin`.
- The Settings API additionally enforces the `v1099_csrf` double-submit (`authorizeAdmin` override).
- Break-glass address is `vibe-breakglass@vibe-1099.local`, not `@localhost` (email validator needs a TLD).
- `breakglassCommand` runs the CLI directly under `node --import tsx` (clean `--json` output) rather than through `pnpm --filter … exec`.
- HTTP-level checks live in the fake-IdP end-to-end runner; no supertest scaffold was added.
