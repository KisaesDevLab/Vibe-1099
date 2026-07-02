# IRIS ATS checklist (firm onboarding step 4)

Run in Settings → environment = **ATS**. Every ATS transmission carries `TestFileCd = T` and the
UI shows a test banner. Use the payer/recipient data from the IRS ATS scenario package.

- [ ] **Communication test:** transmit a minimal 1-record 1099-NEC batch; confirm a Receipt ID
      is captured in the transmission log.
- [ ] **Scenario transmissions:** submit each IRS-published ATS scenario for the form types the
      firm will file (NEC, MISC, INT, DIV).
- [ ] **Ack retrieval:** confirm each scenario reaches a terminal ack (accepted / rejected as
      the scenario dictates) via the automatic poller.
- [ ] **Correction scenario:** file the ATS correction scenario (one-transaction) and confirm
      acceptance.
- [ ] **Error handling:** deliberately submit the bad-TIN scenario; confirm the record lands in
      the exception queue with a translated error.
- [ ] Record the ATS passing date + IRS confirmation; flip the TCC to Production with the IRS,
      then switch Settings → environment to **PROD**.

Local dry-run without the IRS: `pnpm --filter @vibe1099/worker mock-iris` and set
`IRIS_MOCK_BASE_URL=http://localhost:8299` — the mock mirrors intake/status/token endpoints,
duplicate-UTID rejection, record-level TIN errors (TIN ending 99), and whole-file rejection.
