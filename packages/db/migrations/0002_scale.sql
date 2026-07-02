-- Scale-to-100-entities: filing runs, notifications, saved views, payer presets.

-- per-payer default form types (preset so invites/grids default without re-picking)
ALTER TABLE payers ADD COLUMN default_form_types jsonb NOT NULL DEFAULT '["NEC"]'::jsonb;

-- Filing Run: a bulk fleet operation (transmit-all, mo-all, batch-all, summary-all, invite-all)
-- with a dry-run preview, progress, and a per-item result report.
CREATE TABLE filing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  kind text NOT NULL CHECK (kind IN ('transmit','mo_file','paper_batch','summary_zip','invite','w9')),
  tax_year integer NOT NULL,
  status text NOT NULL DEFAULT 'preview'
    CHECK (status IN ('preview','running','completed','partial','failed')),
  scope jsonb NOT NULL,          -- { payerIds, formTypes, statuses, ... }
  total integer NOT NULL DEFAULT 0,
  succeeded integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  items jsonb,                   -- [{ payerId, label, ok, message, refId }]
  result_blob_id uuid REFERENCES blobs(id),  -- e.g. the summary zip
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX filing_runs_firm_idx ON filing_runs (firm_id, tax_year, created_at DESC);

-- Notifications: async job completions + alerts, persistent + per-user or firm-wide.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  user_id uuid REFERENCES users(id),   -- null = all staff in the firm
  kind text NOT NULL,                   -- filing_run | transmission | batch | alert | mo | delivery
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','error')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',        -- in-app route to the relevant screen
  entity_type text,
  entity_id text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_firm_idx ON notifications (firm_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (firm_id, read_at) WHERE read_at IS NULL;

-- Saved views: per-user named filter/sort presets for any list screen.
CREATE TABLE saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  user_id uuid NOT NULL REFERENCES users(id),
  screen text NOT NULL,                 -- 'dashboard' | 'recipients' | 'forms' | ...
  name text NOT NULL,
  config jsonb NOT NULL,                -- { sort, filters, ... }
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_views_user_idx ON saved_views (firm_id, user_id, screen);
