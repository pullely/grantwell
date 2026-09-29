-- 210_grant_reminders
-- The reminder ladder — one row per rung actually sent for a deadline
-- Bounded context: grant
-- schema grant: The daily sweep derives each open deadline's rung from its
-- due_on (30/14/7/1/0 days before, 1 and 7 days after) and claims it here
-- before sending. The unique key is the idempotency: a rung that already has a
-- row is never sent again, however many sweeps run. The key includes due_on,
-- so moving a deadline's due date re-arms its ladder.

CREATE TABLE IF NOT EXISTS grant_reminders (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  deadline_id  TEXT NOT NULL REFERENCES grant_deadlines (id) ON DELETE CASCADE,
  rung         TEXT NOT NULL CHECK (rung IN ('d30','d14','d7','d1','d0','late1','late7')),
  due_on       TEXT NOT NULL,
  recipients   TEXT NOT NULL,
  escalated    INTEGER NOT NULL DEFAULT 0 CHECK (escalated IN (0, 1)),
  sent_at      TEXT NOT NULL
);

-- table grant_reminders: A rung of a deadline's reminder ladder that was claimed (and sent). Every query must scope by org_id.
-- column grant_reminders.rung: d30, d14, d7, d1, d0 before the due date; late1, late7 after it.
-- column grant_reminders.due_on: The deadline's due_on when the rung was claimed; part of the claim key.
-- column grant_reminders.recipients: Comma-separated addresses the rung was sent to.
-- column grant_reminders.escalated: 1 when the grant lead was among the recipients.

CREATE UNIQUE INDEX IF NOT EXISTS uq_grant_reminders_rung ON grant_reminders (deadline_id, rung, due_on);
CREATE INDEX IF NOT EXISTS idx_grant_reminders_org ON grant_reminders (org_id, sent_at);
