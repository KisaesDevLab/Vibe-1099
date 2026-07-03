-- Async TaxBandits TIN matching: store the submission + record refs so a pending
-- result can be polled for its Success/Failed verdict.
ALTER TABLE tin_match_results
  ADD COLUMN IF NOT EXISTS submission_ref text,
  ADD COLUMN IF NOT EXISTS record_ref text;
