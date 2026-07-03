# Getting started

## Signing in
Go to the app URL and sign in at **/login** with your email and password. If two-factor is enabled on your account, you'll also enter a 6-digit code from your authenticator app.

- Forgot your password? Use the reset link, or ask an admin to set a new one (Settings → Users → **Reset password**).
- Sessions time out after a period of inactivity; just sign in again.

## The layout
The staff app has a left sidebar grouped into four sections:

- **Season** — Dashboard, Work inbox, Fleet operations, Form entry, Client review queue, Corrections.
- **People** — Payers, Recipients, Client invites, W-9 requests.
- **Filing & delivery** — IRS transmissions, Missouri, Paper batches, Deliveries.
- **Admin** — Settings.

At the top right of every screen: a **notification bell** (filing results, alerts) and a reminder that **Ctrl/⌘-K** opens the command palette to jump anywhere fast.

## First-run setup (admin)
Before your first filing, an admin should configure the firm in **[Settings](settings-and-admin.md)**:

1. **Firm profile** — legal name, EIN, address, phone. This appears on forms and as the return address on mailed Copy B.
2. **E-file backend** — choose **IRIS** (your firm transmits, needs a TCC + signing key) or **Tax1099** (managed, needs an API key). See [IRS transmissions](filing-irs-and-tax1099.md).
3. **Delivery** — set up **email** (EmailIt or SMTP) and optionally **SMS** for portal/W-9 links.
4. **Users** — add your team with the right roles.
5. **Filing year** — confirm the current tax year (Settings → Advanced → Filing years). Roll it forward each season — see [Tax-year rollover](tax-year-rollover.md).

## Picking a tax year
Every working screen has a **Tax year** selector. It lists the years your firm has enabled and defaults to the current one. Prior years stay available for late filings and corrections.

## Where to go next
If you're running a season for the first time, read the **[Season workflow](season-workflow.md)** — it walks the whole process from onboarding a payer to a filing being accepted.
