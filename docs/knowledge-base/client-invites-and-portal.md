# Client invites & the client portal

Let the businesses you file for enter their own contractor amounts through a secure, single-purpose link. You review what they submit before anything is filed.

---

## Client invites (staff)
**Sidebar:** People → **Client invites**

**What it's for:** creating and managing the magic links that open the client portal.

**Key actions:**
- **Invite a payer** — choose the payer, tax year, and which form types they may report. The app generates a scoped link and can email/text it.
- **Bulk invite / resend outstanding** — invite many payers at once, or re-send to those who haven't submitted. You can scope these to a chosen set of payers.
- Track each invite's state: sent, opened, submitted, expired, revoked.
- **Revoke / reissue** a link (the old link stops working immediately).

**Scope & safety:** a link is bound to **one payer + one tax year**. A client can never see other payers, other years, or staff data.

---

## The client portal (what your client sees)
**URL:** `/client?token=…` (from the invite)

A simple, **mobile-friendly** three-step flow:

**1. Landing** — confirms the firm, the entity name, the tax year, and plain-language instructions. If more than one form type is enabled, they pick what they're reporting.

**2. Contractors & amounts** — a grid that:
- **Pre-lists last year's contractors** for that payer so they just fill in amounts. The list is kept **per form type**: last year's 1099-NEC subcontractors appear on the NEC grid and 1099-MISC recipients (landlords etc.) on the MISC grid — switching form types switches lists without losing anything already entered.
- On forms with more than one payment category (1099-MISC, INT, DIV), each row has a **"Type of payment"** choice — e.g. rents, royalties, or other income — which lands in the matching box on the filed form.
- Lets them **add a new contractor** (name, address, contact). Typing a tax ID does a masked vault lookup — "We have JOHN D— on file, is this them?" — so duplicates are avoided without exposing anyone's data.
- Offers **"no W-9 — request one"** if they don't have a contractor's tax ID; the app emails the contractor a W-9 link.
- Lets them **click any name** to view that contractor's full name and mailing address (tax ID stays truncated).
- Shows the **entity name at the top** and a **Back** button to the start.

**3. Review & submit** — a summary with the total, then submit.

**After a form is filed:** rows for filed 1099s become **read-only** and gain a **Print 1099** link so the client can download a substitute Copy B (with truncated IDs) for their records.

**Save & finish later:** clients can save a draft and return via the same link until they submit.

---

## What happens to a submission
Client entries arrive as draft records flagged *client-submitted* and land in the **[Client review queue](form-entry-and-review.md#client-review-queue)**. Nothing a client enters is filed until a staff member reviews and advances it. If a client needs to change something after submitting, an admin can re-open the engagement.
