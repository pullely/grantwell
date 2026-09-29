-- 220_grant_digests
-- The grant writer's weekly digest — one row per writer per week actually sent
-- Bounded context: grant
-- schema grant: Every Monday the sweep sends each member of two or more
-- organizations one email listing every open deadline across them. The row is
-- claimed before the send (UNIQUE subject + week), so a writer gets one digest
-- a week however many sweeps run. Keyed by subject, not org: a digest spans
-- the writer's organizations.

CREATE TABLE IF NOT EXISTS grant_digests (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL,
  week_of     TEXT NOT NULL,
  address     TEXT NOT NULL,
  org_count   INTEGER NOT NULL CHECK (org_count >= 0),
  sent_at     TEXT NOT NULL
);

-- table grant_digests: A weekly portfolio digest claimed (and sent) for one writer. Scoped by subject, not org.
-- column grant_digests.subject_id: The member's user id, as membership stores it.
-- column grant_digests.week_of: The Monday (UTC, YYYY-MM-DD) of the week the digest covers; part of the claim key.
-- column grant_digests.address: Where it was sent.

CREATE UNIQUE INDEX IF NOT EXISTS uq_grant_digests_week ON grant_digests (subject_id, week_of);
