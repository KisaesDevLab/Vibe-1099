-- Allow the 'archive_zip' filing-run kind (per-payer 1099 archive PDFs → ZIP).
ALTER TABLE filing_runs DROP CONSTRAINT IF EXISTS filing_runs_kind_check;
ALTER TABLE filing_runs
  ADD CONSTRAINT filing_runs_kind_check
    CHECK (kind IN ('transmit','mo_file','paper_batch','summary_zip','archive_zip','invite','w9'));
