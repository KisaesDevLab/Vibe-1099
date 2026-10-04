-- Blobs are disposable artifacts (batch PDFs, report/export zips, W-9 PDFs, IRIS
-- XML/acks, provider payloads, MO .txt) that housekeeping purges on a schedule
-- and that batch delete removes on demand. The rows pointing at them must
-- survive with a NULL pointer: with the original NO ACTION foreign keys every
-- purge raised a 23503 once any referenced blob aged past the cutoff (so the
-- hourly housekeeping job failed forever) and DELETE /batches/:id 500'd on any
-- built batch.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.confrelid = 'blobs'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE transmissions
  ADD CONSTRAINT transmissions_xml_blob_id_fkey FOREIGN KEY (xml_blob_id) REFERENCES blobs(id) ON DELETE SET NULL,
  ADD CONSTRAINT transmissions_ack_blob_id_fkey FOREIGN KEY (ack_blob_id) REFERENCES blobs(id) ON DELETE SET NULL;
ALTER TABLE state_files
  ADD CONSTRAINT state_files_file_blob_id_fkey FOREIGN KEY (file_blob_id) REFERENCES blobs(id) ON DELETE SET NULL;
ALTER TABLE paper_batches
  ADD CONSTRAINT paper_batches_pdf_blob_id_fkey FOREIGN KEY (pdf_blob_id) REFERENCES blobs(id) ON DELETE SET NULL;
ALTER TABLE w9_requests
  ADD CONSTRAINT w9_requests_pdf_blob_id_fkey FOREIGN KEY (pdf_blob_id) REFERENCES blobs(id) ON DELETE SET NULL;
ALTER TABLE filing_runs
  ADD CONSTRAINT filing_runs_result_blob_id_fkey FOREIGN KEY (result_blob_id) REFERENCES blobs(id) ON DELETE SET NULL;
