-- 200_grant_core
-- Grants foundation — a nonprofit's grants, the report and deliverable deadlines
-- each award creates, and the award letters stored in R2
-- Bounded context: grant
-- schema grant: Grants bounded context — owns the grant (funder, amount, period,
-- restrictions), every dated obligation the award creates (reports, deliverables,
-- the renewal), and the documents uploaded against it. "On time" is derived from
-- submitted_at and due_on; it is never stored.

CREATE TABLE IF NOT EXISTS grant_grants (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  title                 TEXT NOT NULL,
  funder_name           TEXT NOT NULL,
  funder_contact_name   TEXT,
  funder_contact_email  TEXT,
  amount_cents          INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency              TEXT NOT NULL DEFAULT 'USD',
  period_start          TEXT,
  period_end            TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','declined')),
  restrictions          TEXT NOT NULL DEFAULT '',
  lead_email            TEXT,
  notes                 TEXT NOT NULL DEFAULT '',
  created_by            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start)
);

-- table grant_grants: One grant a nonprofit has been awarded (or is tracking). Every query must scope by org_id.
-- column grant_grants.amount_cents: The award in integer cents of currency. Never a float.
-- column grant_grants.period_start: Grant period start, YYYY-MM-DD; a string comparison is a date comparison.
-- column grant_grants.lead_email: The grant lead. Escalating reminders (GW2) add this address.

CREATE INDEX IF NOT EXISTS idx_grant_grants_org_status ON grant_grants (org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS grant_deadlines (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  grant_id        TEXT NOT NULL REFERENCES grant_grants (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL
                  CHECK (kind IN ('narrative_report','financial_report','deliverable','renewal','other')),
  title           TEXT NOT NULL,
  due_on          TEXT NOT NULL,
  assignee_email  TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','waived')),
  submitted_at    TEXT,
  notes           TEXT NOT NULL DEFAULT '',
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'submitted') = (submitted_at IS NOT NULL))
);

-- table grant_deadlines: A dated obligation a grant creates — a report, a deliverable, the renewal. Every query must scope by org_id.
-- column grant_deadlines.due_on: Due date, YYYY-MM-DD, no time zone.
-- column grant_deadlines.assignee_email: The person responsible; assignment and reminder emails go here.
-- column grant_deadlines.submitted_at: Set exactly when status is 'submitted'; on time means submitted_at's date <= due_on.

CREATE INDEX IF NOT EXISTS idx_grant_deadlines_org_due ON grant_deadlines (org_id, status, due_on);
CREATE INDEX IF NOT EXISTS idx_grant_deadlines_grant ON grant_deadlines (grant_id, due_on);

CREATE TABLE IF NOT EXISTS grant_documents (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  grant_id      TEXT NOT NULL REFERENCES grant_grants (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'award_letter' CHECK (kind IN ('award_letter','report','other')),
  object_key    TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size > 0),
  sha256        TEXT NOT NULL,
  uploaded_by   TEXT,
  uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table grant_documents: A file uploaded against a grant — the award letter first. Immutable: a correction is a new document.
-- column grant_documents.object_key: R2 key in the GRANT_DOCS bucket: orgs/{org_id}/grants/{grant_id}/{document_id}.
-- column grant_documents.sha256: Hex SHA-256 computed by grant-worker at upload, returned as x-content-sha256 on download.

CREATE INDEX IF NOT EXISTS idx_grant_documents_grant ON grant_documents (grant_id, uploaded_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_grant_documents_object ON grant_documents (object_key);
