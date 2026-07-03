# Season workflow (end to end)

This is the big picture: how a filing season flows through the app. Each step links to the screen that does the work.

### 1. Set up (once per season)
- Confirm the **firm profile** and **e-file backend** in [Settings](settings-and-admin.md).
- **Roll the filing year forward** if needed ([Tax-year rollover](tax-year-rollover.md)).

### 2. Onboard the entities you file for
- Add or import **[Payers](payers.md)** (the businesses). CSV import handles many at once.
- Optionally set a per-payer **filing backend override** (IRIS vs Tax1099).

### 3. Get the data — two ways
**A. You enter it.** Add contractors to the **[Recipients](recipients.md)** vault, then key amounts on the **[Form entry](form-entry-and-review.md)** grid (payer → recipient rows).

**B. The client enters it.** Send **[Client invites](client-invites-and-portal.md)**. The client opens a magic link, sees last year's contractors pre-listed, enters amounts, and submits. Their entries land in the **[Client review queue](form-entry-and-review.md#client-review-queue)** for you to approve.

### 4. Fill gaps
- Missing a tax ID? Send a **[W-9 request](w9.md)**. The contractor completes it through a secure link and it flows back to the vault.
- Use **TIN check** on a recipient (if Tax1099 is configured) to verify a name/TIN before filing.

### 5. Review and stage
- Move forms from **draft → ready → queued**. If the reviewer gate is on, a reviewer approves before queuing.
- The **[Work Inbox](dashboard-and-inbox.md)** shows everything still needing attention across all payers.

### 6. E-file to the IRS
- Transmit per payer from [IRS transmissions](filing-irs-and-tax1099.md), or run **transmit-all** across many payers from **[Fleet operations](fleet-operations.md)**.
- The app sends the filing and then **polls for the acknowledgement**, moving records to **accepted**, **accepted with errors**, or **rejected** automatically. You'll get a notification.

### 7. File the state (Missouri)
- For MO-source records, generate the **[Missouri](missouri.md)** Pub 1220 `.txt` file, upload it at mytax.mo.gov, and mark it uploaded/accepted.

### 8. Deliver Copy B
- Build **[Paper batches](paper-batches.md)** — a Z-fold pressure-seal sheet per form. Paper Copy B is **always** mailed.
- Optionally send **[portal courtesy copies](deliveries-and-recipient-portal.md)** by email/SMS so recipients can view/download online too.

### 9. Handle exceptions
- **Rejected** records return to draft — fix and re-queue.
- After acceptance, any change goes through **[Corrections](corrections.md)** (Type 1 or Type 2), which the app derives from the immutable as-filed snapshot.

### 10. Track to done
- The **[Dashboard](dashboard-and-inbox.md)** shows per-payer progress and deadline risk. Save views for the cuts you check often.

> **Deadlines reminder:** 1099-NEC recipient copies **and** the IRS e-file are both due Jan 31. MISC/INT/DIV e-file is due Mar 31 (recipient copies Jan 31). Missouri is the last day of February. The IRS transmissions screen shows the exact dates for the selected year.
