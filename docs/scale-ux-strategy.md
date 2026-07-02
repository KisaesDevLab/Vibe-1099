# Strategy — Scaling Vibe 1099 to 100+ filing entities

> **Status (2026-07-02): all three phases implemented and live-verified.** Pagination + total
> counts, searchable pickers, recipient grid picker, and payer CSV import (Phase A); the Filing
> Run abstraction with transmit-all / summary-all, invite & W-9 campaigns, the Work Inbox, and the
> notification center (Phase B); the control-tower dashboard, saved views, and Ctrl/⌘-K command
> palette (Phase C). See the commit history and `SECURITY.md` invariants.

## The core reframe

Vibe 1099 today is built around a **per-entity data-entry mental model**: pick one payer, key its
forms, transmit it, deliver it, repeat. That model is fine for 5–10 clients and collapses at 100
because every action is O(entities) of human effort and the lists silently hide data beyond the
first page.

Scaling is not "add more screens" — it is a shift to a **portfolio filing operations platform**
built on three moves:

1. **Delegate collection to the clients.** The 100 payers enter their own contractors through the
   portal; the firm's job shifts from *typing* to *reviewing and clearing exceptions*. The portal
   already exists — the strategy is to make it the default path and industrialize the invite/review
   loop around it.
2. **Fleet operations.** Every per-payer action (transmit, generate MO file, build batch, compose
   delivery, produce summary PDF) gets an **"all / selected" counterpart** with preview and
   partial-failure reporting. Season-close should be a handful of reviewed bulk actions, not 100
   repetitions.
3. **Exception-driven work.** The system surfaces *what needs a human* — missing W-9s, rejected
   records, unfiled payers with a deadline approaching — as a worklist. Staff work the queue; they
   do not scan 100 rows looking for problems.

Everything below serves those three moves.

---

## Design principles (every feature obeys these)

1. **Never hide data.** Every list is paginated with a visible total count (`showing 100 of 1,842`)
   or virtualized. No silent truncation. *This is a correctness rule, not a nicety — today
   Recipients caps at 100 invisibly.*
2. **Search-first navigation.** A global command palette (jump to any payer/recipient/form) and
   searchable comboboxes everywhere replace 100-option `<select>`s and 100-checkbox walls.
3. **Every per-payer action has an all/selected sibling** — always with a **dry-run preview**
   (counts, totals, warnings) and a **per-item result report** afterward. Bulk on tax filings must
   be safe, not fast-and-loose.
4. **Work the queue, not the list.** A unified Work Inbox aggregates every "needs attention" signal
   with one-click resolution or bulk resolution.
5. **Templates and rollforward kill repetition.** Prior-year rollforward, per-payer form-type
   presets, saved delivery/MO scopes, message templates — defaults so the common case is zero-input.
6. **Async work is visible.** Long-running jobs (render, transmit, ack-poll, MO generate, bulk
   sends) are first-class objects with progress and a notification when done — surfaced even after
   the user navigates away.
7. **Safe bulk.** Dry-run preview → confirm → idempotent execution → reviewer gate respected →
   per-item audit → partial-failure report. A bulk transmit can never silently misfile.

---

## New organizing concepts to introduce

These are the few new objects that make the whole system cohere; most reuse infrastructure that
already exists (BullMQ, the audit log, the reviewer gate).

| Concept | What it is | Builds on |
|---|---|---|
| **Work Inbox** | One prioritized queue unifying: client-submitted reviews, missing W-9/address, rejected records, undelivered, unfiled-near-deadline. Filter by kind/payer; bulk-resolve. | today's scattered exception queue + review queue |
| **Filing Run** | A bulk job object (transmit-all, generate-all-MO, build-all-batches, invite-all). Has scope, dry-run preview, progress, and a per-item result. | BullMQ queues, `transmissions`/`paper_batches` rows |
| **Campaign** | A tracked send of invites or W-9 requests to many recipients, with per-recipient status (sent/opened/completed) and resend-outstanding. | `client_invites`, `w9_requests` |
| **Saved View** | Named filter+sort presets on any list ("payers with rejects", "unfiled NEC"). | `app_settings` per user |
| **Engagement rollup** | Per-payer status object (collected → reviewed → ready → filed → delivered) driving the control tower. | existing per-payer aggregates in `dashboard.ts` |
| **Notification center** | Async job completions + alerts, persistent, visibility-aware. | worker already emits; add a `notifications` table + SSE/poll |

---

## Workflow redesign — the season lifecycle

### Phase 1 · Setup (Sept–Dec)
- **Payer bulk import** (CSV, column-mapper + dedupe-by-TIN preview) mirroring the recipient
  importer — turns 100 hand-typed payers into one reviewed upload.
- **Per-payer form-type presets** (this client files NEC + MISC) so invites and grids default
  correctly without re-picking each time.
- **Rollforward-all**: clone last year's recipient sets for all payers in one reviewed action.

### Phase 2 · Collect (early Jan) — *portal-first*
- **Invite campaign**: select many payers (searchable, filter "not yet invited") → generate + send
  in one pass → track as a Campaign with per-payer status; **resend-all-outstanding** with one click.
- **W-9 campaign**: same shape for the missing-TIN population, surfaced from the Work Inbox.
- Goal: the firm's January starts with one bulk invite, not 100.

### Phase 3 · Prepare & review
- **Work Inbox** replaces hunting. Client submissions arrive grouped **by engagement** (one card per
  payer with N contractors) → review the diff-vs-vault → **bulk-accept the engagement**, not row by
  row.
- **Staff grid** gets the vault **recipient picker** in add-row (kills the `prompt()` UUID paste),
  a **searchable payer combobox**, virtualization, pagination with counts, and paste-from-Excel.
- **Cross-payer worklists**: "all payers missing an address", "all NEC not yet ready" — act across
  entities, not one at a time.

### Phase 4 · File (Jan 31 / Mar 31 / end-Feb)
- **Fleet transmit**: select payers (or "all with queued records") → **dry-run preview** (record
  counts, TIN/threshold warnings, size/batch split) → one confirmed **Filing Run** that fans out
  per-payer IRIS submissions under the hood (preserving per-payer issuer XML, UTID idempotency, the
  100 MB cap, and the reviewer gate) → progress + per-payer result. Same pattern for **MO
  generate-all** and **build-all paper batches**.
- **Season-close cockpit**: a single checklist screen — "78/100 payers accepted, 12 queued, 6
  rejected, 4 unfiled" — with the bulk actions inline and deadline risk per payer.

### Phase 5 · Deliver
- Bulk compose already exists; extend it with the searchable/multi-select payer picker and a
  **delivery campaign** view (sent/viewed/bounced across ~1,500 sends, filterable by payer).

### Phase 6 · Correct & close
- Corrections discovered from the Work Inbox (rejected records land there automatically with the
  translated IRIS error), corrected in place, and **re-transmitted as a Filing Run**.
- **Generate-all client summary PDFs** → one zip per firm for workpapers/delivery, instead of 100
  downloads.

---

## The Control Tower (dashboard redesign)

The dashboard becomes the operational hub, answering "what needs me now?" across 100 entities:

- **Roll-up header**: filed/accepted/rejected/delivered totals + the nearest at-risk deadline.
- **Sortable, filterable, searchable progress table** with per-payer **deadline-risk** flags and
  saved views ("show rejects", "unfiled <3 days", "undelivered").
- **Work Inbox** front and center — un-truncated, filterable, paginated, with bulk-resolve.
- **Active Filing Runs** with live progress and notifications.

---

## Technical enablers (what to build underneath)

- **Pagination + total counts** on every list endpoint (the API already accepts `offset`; add
  `total` and cursor support) and **virtualized tables** on the frontend.
- **Server-side search** endpoints (payers, recipients, forms) backing the comboboxes and command
  palette.
- **Bulk endpoints returning a Filing Run id** (`POST /iris/transmit-all`, `/mo/generate-all`,
  `/batches/build-all`, `/invites/bulk`) — each with a `?dryRun=1` preview mode; execution fans out
  to existing per-payer services so all compliance invariants hold.
- **Jobs + notifications model**: a `filing_runs` table (scope, status, per-item results) and a
  `notifications` table; deliver via SSE or visibility-aware polling. The BullMQ workers already do
  the work — this makes it *visible and resumable*.
- **Saved views**: per-user filter presets in `app_settings`.
- **Safe-bulk middleware**: enforce reviewer gate, idempotency (reuse UTID guard), and write one
  audit entry per affected record inside a run.

All of this is **additive** — it wraps the existing single-payer services rather than rewriting them.

---

## Roadmap (sequenced to the season calendar)

**Phase A — Blockers (must land before any real data).** Correctness + baseline usability.
- Pagination + total counts across Recipients, Forms, Deliveries, Corrections, Exceptions, Payers.
- Recipient vault **picker** in grid add-row (remove `prompt()`).
- Searchable payer **combobox** replacing the 100-option select and 100-checkbox walls.
- Payer **CSV import**.
> Outcome: no hidden data; a staffer can actually navigate 100 entities.

**Phase B — Fleet operations (before January).** The scale multipliers.
- **Filing Run** abstraction + dry-run preview + result report.
- Bulk **transmit-all / MO generate-all / build-all-batches / generate-all-summaries**.
- **Invite & W-9 campaigns** (bulk send + resend-outstanding + status).
- **Work Inbox** (unified, paginated, filterable, bulk-resolve) + client-review batching by
  engagement.
- **Notification center** + visibility-aware polling.
> Outcome: season-close is a dozen reviewed bulk actions, not thousands of clicks.

**Phase C — Control tower & polish (in-season and iterate).**
- Dashboard redesign (roll-up, sort/filter, deadline risk, saved views).
- Global **command palette** / search.
- Per-payer presets, saved delivery/MO scopes, paste-from-Excel, table virtualization tuning.
> Outcome: the firm runs the whole portfolio from one screen.

---

## Success metrics

- **Staff touches per 100 filings** (target: portal path → near-zero keystrokes for collection;
  review is per-engagement not per-form).
- **% of forms collected via the client portal** (the delegation lever; target majority).
- **Season-close click count** (transmit + MO + deliver for all payers → single-digit reviewed
  actions).
- **Exceptions cleared per staff-hour** from the Work Inbox.
- **Time-to-first-value** for a new client (import → invited → collecting).
- **Zero hidden-data incidents** (every list shows a truthful total).

---

## Risks & guardrails

- **Bulk misfiling is the top risk.** Every Filing Run is dry-run-previewed, respects the reviewer
  gate, is UTID-idempotent (no double-transmit), and writes per-record audit entries. No bulk action
  skips the snapshot-on-transmit or the per-payer issuer/TCC XML.
- **Partial failure must be legible.** A run that files 96/100 payers reports exactly which 4 failed
  and why, and is resumable — never "done" when it isn't.
- **Delegation ≠ blind trust.** Client-submitted data always lands as `draft`/`client_submitted` in
  the Work Inbox for staff review before anything is filed (already the model — keep it).
- **Deadline pressure amplifies UI mistakes.** The control tower must make the *unfiled-and-at-risk*
  set impossible to miss, and destructive bulk actions must confirm scope explicitly.
- **Scope creep vs. the January clock.** Phase A is non-negotiable and small; Phase B is the ROI;
  Phase C iterates. Ship A fully before starting B.
