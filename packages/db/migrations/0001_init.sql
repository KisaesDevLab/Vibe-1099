-- Vibe 1099 — initial schema
-- Money: integer cents (ADR-001). TIN lookup: HMAC tin_hash (ADR-002).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE firms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  ein text NOT NULL,
  address jsonb NOT NULL,
  phone text NOT NULL DEFAULT '',
  iris_tcc text NOT NULL DEFAULT '',
  iris_api_client_id text NOT NULL DEFAULT '',
  iris_jwk_encrypted text,
  iris_jwk_public jsonb,
  iris_environment text NOT NULL DEFAULT 'ATS',
  mo_withholding_id text NOT NULL DEFAULT '',
  smtp_override jsonb,
  sms_override jsonb,
  imposition_offset_x16 integer NOT NULL DEFAULT 0,
  imposition_offset_y16 integer NOT NULL DEFAULT 0,
  license_key text NOT NULL DEFAULT '',
  license_tier text NOT NULL DEFAULT 'internal',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','preparer','reviewer')),
  totp_secret_encrypted text,
  totp_enabled boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (firm_id, email);

CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  legal_name text NOT NULL,
  dba_name text NOT NULL DEFAULT '',
  tin_encrypted text NOT NULL,
  tin_type text NOT NULL CHECK (tin_type IN ('SSN','EIN')),
  tin_last4 text NOT NULL,
  address jsonb NOT NULL,
  phone text NOT NULL DEFAULT '',
  contact_email text,
  contact_mobile text,
  mo_withholding_id text,
  mo_source_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  payer_id uuid NOT NULL REFERENCES payers(id),
  tax_year integer NOT NULL,
  form_types jsonb NOT NULL,
  token_hash text NOT NULL,
  email text,
  mobile text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  submitted_at timestamptz,
  reopened_at timestamptz,
  draft_state jsonb,
  last_activity_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_invites_payer_idx ON client_invites (payer_id, tax_year);
CREATE UNIQUE INDEX client_invites_token_uq ON client_invites (token_hash);

CREATE TABLE recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  tin_encrypted text NOT NULL,
  tin_hash text NOT NULL,
  tin_type text NOT NULL CHECK (tin_type IN ('SSN','EIN')),
  tin_last4 text NOT NULL,
  is_itin boolean NOT NULL DEFAULT false,
  name1 text NOT NULL,
  name2 text NOT NULL DEFAULT '',
  address jsonb NOT NULL,
  email text,
  mobile text,
  sms_opt_out boolean NOT NULL DEFAULT false,
  w9_status text NOT NULL DEFAULT 'none' CHECK (w9_status IN ('none','requested','on_file','stale')),
  w9_completed_at timestamptz,
  backup_withholding boolean NOT NULL DEFAULT false,
  created_from text NOT NULL DEFAULT 'staff' CHECK (created_from IN ('staff','client','w9','import')),
  merged_into_id uuid REFERENCES recipients(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- unique active TIN per firm (merged-away rows excluded)
CREATE UNIQUE INDEX recipients_tin_hash_uq ON recipients (firm_id, tin_hash) WHERE merged_into_id IS NULL;
CREATE INDEX recipients_name_idx ON recipients (firm_id, name1);

CREATE TABLE recipient_address_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES recipients(id),
  name1 text NOT NULL,
  name2 text NOT NULL DEFAULT '',
  address jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('staff','client','w9','import','merge')),
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rah_recipient_idx ON recipient_address_history (recipient_id, created_at DESC);

CREATE TABLE blobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid,
  kind text NOT NULL,
  content_type text NOT NULL,
  filename text NOT NULL DEFAULT '',
  bytes bytea NOT NULL,
  encrypted boolean NOT NULL DEFAULT false,
  size integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transmissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  tax_year integer NOT NULL,
  environment text NOT NULL CHECK (environment IN ('ATS','PROD')),
  utid text NOT NULL,
  receipt_id text,
  status text NOT NULL DEFAULT 'building'
    CHECK (status IN ('building','transmitting','transmitted','polling','accepted','accepted_with_errors','rejected','failed')),
  is_correction boolean NOT NULL DEFAULT false,
  record_count integer NOT NULL DEFAULT 0,
  xml_blob_id uuid REFERENCES blobs(id),
  ack_blob_id uuid REFERENCES blobs(id),
  ack_payload jsonb,
  error_details jsonb,
  cfsf_states jsonb,
  transmitted_at timestamptz,
  resolved_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transmissions_utid_uq ON transmissions (utid);

CREATE TABLE form_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  payer_id uuid NOT NULL REFERENCES payers(id),
  recipient_id uuid NOT NULL REFERENCES recipients(id),
  tax_year integer NOT NULL,
  form_type text NOT NULL CHECK (form_type IN ('NEC','MISC','INT','DIV')),
  box_values jsonb NOT NULL,
  account_number text NOT NULL DEFAULT '',
  second_tin_notice boolean NOT NULL DEFAULT false,
  mo_source boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ready','queued','transmitted','accepted','accepted_with_errors','rejected','corrected')),
  client_submitted boolean NOT NULL DEFAULT false,
  client_invite_id uuid REFERENCES client_invites(id),
  reviewed_by uuid REFERENCES users(id),
  filed_snapshot jsonb,
  corrects_id uuid REFERENCES form_records(id),
  correction_seq integer NOT NULL DEFAULT 0,
  correction_type text CHECK (correction_type IN ('one_transaction','two_transaction_zero','two_transaction_new','void')),
  correction_reason text,
  transmission_id uuid REFERENCES transmissions(id),
  record_errors jsonb,
  notes text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_records_payer_idx ON form_records (payer_id, tax_year, form_type);
CREATE INDEX form_records_recipient_idx ON form_records (recipient_id, tax_year);
CREATE INDEX form_records_status_idx ON form_records (firm_id, tax_year, status);

CREATE TABLE state_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  state text NOT NULL DEFAULT 'MO',
  tax_year integer NOT NULL,
  payer_ids jsonb NOT NULL,
  record_count integer NOT NULL DEFAULT 0,
  k_record_totals jsonb,
  file_blob_id uuid REFERENCES blobs(id),
  filename text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated','uploaded','accepted','rejected','superseded')),
  status_notes text NOT NULL DEFAULT '',
  form_record_ids jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE paper_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  tax_year integer NOT NULL,
  label text NOT NULL DEFAULT '',
  pdf_blob_id uuid REFERENCES blobs(id),
  page_count integer NOT NULL DEFAULT 0,
  form_count integer NOT NULL DEFAULT 0,
  form_record_ids jsonb NOT NULL,
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','built','printed','delivered','failed')),
  printed_at timestamptz,
  delivered_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  form_record_id uuid NOT NULL REFERENCES form_records(id),
  channel text NOT NULL CHECK (channel IN ('paper','email','sms')),
  token_hash text,
  token_expires_at timestamptz,
  token_revoked_at timestamptz,
  is_corrected boolean NOT NULL DEFAULT false,
  sent_at timestamptz,
  bounced_at timestamptz,
  viewed_at timestamptz,
  downloaded_at timestamptz,
  fail_reason text,
  paper_batch_id uuid REFERENCES paper_batches(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_record_idx ON deliveries (form_record_id);
CREATE UNIQUE INDEX deliveries_token_uq ON deliveries (token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE w9_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  recipient_id uuid REFERENCES recipients(id),
  payer_id uuid REFERENCES payers(id),
  requested_name text NOT NULL DEFAULT '',
  email text,
  mobile text,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','opened','completed','expired','revoked')),
  expires_at timestamptz NOT NULL,
  opened_at timestamptz,
  completed_at timestamptz,
  reminders_sent integer NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  pdf_blob_id uuid REFERENCES blobs(id),
  esign_meta jsonb,
  tin_mismatch boolean NOT NULL DEFAULT false,
  submitted_data jsonb,
  requested_by uuid,
  requested_via text NOT NULL DEFAULT 'staff' CHECK (requested_via IN ('staff','client')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX w9_requests_token_uq ON w9_requests (token_hash);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('staff','client','recipient','system')),
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before_hash text,
  after_hash text,
  detail jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_time_idx ON audit_log (created_at);

-- append-only enforcement
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE error_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'IRIS',
  code text NOT NULL,
  official_text text NOT NULL DEFAULT '',
  plain_english text NOT NULL,
  suggested_fix text NOT NULL DEFAULT '',
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX error_translations_uq ON error_translations (source, code);

CREATE TABLE states_config (
  state text PRIMARY KEY,
  participates_cfsf boolean NOT NULL DEFAULT false,
  direct_required boolean NOT NULL DEFAULT false,
  threshold_cents integer NOT NULL DEFAULT 0,
  format text NOT NULL DEFAULT '',
  portal_url text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT ''
);

CREATE TABLE year_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  tax_year integer NOT NULL,
  locked_by uuid REFERENCES users(id),
  locked_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX year_locks_uq ON year_locks (firm_id, tax_year);

CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- seed: state config stub (MO live; CF/SF participation list is registry/DB-driven)
INSERT INTO states_config (state, participates_cfsf, direct_required, threshold_cents, format, portal_url, notes) VALUES
  ('MO', false, true, 120000, 'pub1220', 'https://mytax.mo.gov', 'Direct file required; $1,200 threshold; Pub 1220 .txt via Online W-2/1099 Submission System'),
  ('AR', true, false, 0, '', '', 'CF/SF participant (code 05) — benefits automatically from CF/SF election');

-- seed: starter IRIS error translations (living table, admin-editable)
INSERT INTO error_translations (source, code, official_text, plain_english, suggested_fix) VALUES
  ('IRIS', 'R-1099-NEC-001', 'PayeeTIN and PayeeName do not match IRS records', 'The recipient''s TIN and name don''t match what the IRS has on file.', 'Verify the TIN against the recipient''s W-9. If the name changed (marriage, business conversion), confirm which name is registered with the SSA/IRS.'),
  ('IRIS', 'R-TRANS-004', 'Duplicate UTID', 'This exact batch was already transmitted.', 'Do not retransmit. Check the transmission log for the original Receipt ID.'),
  ('IRIS', 'SCHEMA-VAL-001', 'XML schema validation failure', 'The submission XML did not match the IRS schema.', 'This is an app-level bug or schema-version mismatch. Check the pinned schema version for the tax year in Settings.');
