-- TaxBandits files one form type per submission (each 1099 form has its own
-- Create/Status/Correction endpoint). Persist the transmission's form type so the
-- ack poller can hit the correct Form1099<TYPE>/Status endpoint.
ALTER TABLE transmissions
  ADD COLUMN IF NOT EXISTS provider_form_type text;
