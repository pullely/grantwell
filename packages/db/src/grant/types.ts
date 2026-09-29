// Grants (grant) bounded context — row shapes and repository seam.
//
// Timestamps are ISO-8601 strings and dates are YYYY-MM-DD strings end to end:
// D1 stores TEXT, the wire carries strings, and a string comparison of two
// such dates is a date comparison.

export interface Grant {
  id: string;
  orgId: string;
  title: string;
  funderName: string;
  funderContactName: string | null;
  funderContactEmail: string | null;
  amountCents: number | null;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: string;
  restrictions: string;
  leadEmail: string | null;
  notes: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GrantFields {
  title: string;
  funderName: string;
  funderContactName: string | null;
  funderContactEmail: string | null;
  amountCents: number | null;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: string;
  restrictions: string;
  leadEmail: string | null;
  notes: string;
}

export interface CreateGrantInput extends GrantFields {
  id: string;
  orgId: string;
  createdBy: string | null;
  now: string;
}

export interface GrantDeadline {
  id: string;
  orgId: string;
  grantId: string;
  kind: string;
  title: string;
  dueOn: string;
  assigneeEmail: string | null;
  status: string;
  submittedAt: string | null;
  notes: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A deadline joined to its grant's title and funder, for the org-wide list. */
export interface GrantDeadlineWithGrant extends GrantDeadline {
  grantTitle: string;
  funderName: string;
}

export interface CreateGrantDeadlineInput {
  id: string;
  orgId: string;
  grantId: string;
  kind: string;
  title: string;
  dueOn: string;
  assigneeEmail: string | null;
  notes: string;
  createdBy: string | null;
  now: string;
}

export interface UpdateGrantDeadlineInput {
  kind: string;
  title: string;
  dueOn: string;
  assigneeEmail: string | null;
  status: string;
  submittedAt: string | null;
  notes: string;
  now: string;
}

export interface GrantDocument {
  id: string;
  orgId: string;
  grantId: string;
  kind: string;
  objectKey: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  uploadedBy: string | null;
  uploadedAt: string;
}

export type CreateGrantDocumentInput = GrantDocument;

export interface ListDeadlinesFilter {
  status?: string | undefined;
  /** Inclusive lower bound on due_on (YYYY-MM-DD). */
  from?: string | undefined;
  /** Inclusive upper bound on due_on (YYYY-MM-DD). */
  through?: string | undefined;
  limit: number;
}

/** An open deadline the reminder sweep may chase, with what the email needs. */
export interface ReminderCandidate extends GrantDeadlineWithGrant {
  grantLeadEmail: string | null;
}

export interface ReminderCandidateFilter {
  /** Inclusive due_on window (YYYY-MM-DD). */
  from: string;
  through: string;
  /** Restrict to one org (the on-demand run); every org when absent (the cron). */
  orgId?: string | undefined;
  limit: number;
}

export interface ClaimReminderInput {
  id: string;
  orgId: string;
  deadlineId: string;
  rung: string;
  dueOn: string;
  recipients: string;
  escalated: boolean;
  sentAt: string;
}

export interface GrantReminder {
  id: string;
  orgId: string;
  deadlineId: string;
  rung: string;
  dueOn: string;
  recipients: string;
  escalated: boolean;
  sentAt: string;
}

/** Per-org deadline counts behind the on-time rate and the overdue count. */
export interface GrantDeadlineCounts {
  open: number;
  overdue: number;
  dueNext30: number;
  submitted: number;
  submittedOnTime: number;
}

export interface ClaimDigestInput {
  id: string;
  subjectId: string;
  /** The Monday (UTC) of the week, YYYY-MM-DD. */
  weekOf: string;
  address: string;
  orgCount: number;
  sentAt: string;
}

export interface GrantRepository {
  createGrant(input: CreateGrantInput): Promise<Grant>;
  getGrant(orgId: string, grantId: string): Promise<Grant | null>;
  listGrants(orgId: string, status?: string): Promise<Grant[]>;
  /** Replace the grant's editable fields. Returns null when no such grant is in the org. */
  updateGrant(orgId: string, grantId: string, fields: GrantFields, now: string): Promise<Grant | null>;

  createDeadline(input: CreateGrantDeadlineInput): Promise<GrantDeadline>;
  getDeadline(orgId: string, grantId: string, deadlineId: string): Promise<GrantDeadline | null>;
  listDeadlinesForGrant(orgId: string, grantId: string): Promise<GrantDeadline[]>;
  /** Open (or filtered) deadlines across every grant in the org, due_on ascending. */
  listDeadlines(orgId: string, filter: ListDeadlinesFilter): Promise<GrantDeadlineWithGrant[]>;
  /** The earliest open deadline of each of these grants. */
  nextOpenDeadlines(orgId: string, grantIds: readonly string[]): Promise<Map<string, GrantDeadline>>;
  /**
   * Replace a deadline's fields. Returns the updated row through RETURNING —
   * never judged by rowCount, which the D1 executor reports as 0 for any
   * write without RETURNING (runbook trap 22).
   */
  updateDeadline(orgId: string, grantId: string, deadlineId: string, input: UpdateGrantDeadlineInput): Promise<GrantDeadline | null>;

  /** Open deadlines of active grants due in the window, due_on ascending. */
  listReminderCandidates(filter: ReminderCandidateFilter): Promise<ReminderCandidate[]>;
  /**
   * Claim one rung for a deadline's current due date. True exactly once per
   * (deadline, rung, due_on): `INSERT … ON CONFLICT DO NOTHING RETURNING id`,
   * counted by returned rows (runbook trap 22), never by rowCount.
   */
  claimReminder(input: ClaimReminderInput): Promise<boolean>;
  listReminders(orgId: string, deadlineId: string): Promise<GrantReminder[]>;
  /** Counts per org for each of these orgs (absent orgs have no deadlines). `today` is YYYY-MM-DD. */
  deadlineCounts(orgIds: readonly string[], today: string): Promise<Map<string, GrantDeadlineCounts>>;

  /** Open deadlines across these orgs (never any other), due_on ascending, with their grant. */
  listOpenDeadlinesForOrgs(orgIds: readonly string[], limit: number): Promise<GrantDeadlineWithGrant[]>;
  /** Claim a writer's digest for a week: true exactly once per (subject, week) — RETURNING, trap 22. */
  claimDigest(input: ClaimDigestInput): Promise<boolean>;

  createDocument(input: CreateGrantDocumentInput): Promise<GrantDocument>;
  listDocuments(orgId: string, grantId: string): Promise<GrantDocument[]>;
  getDocument(orgId: string, grantId: string, documentId: string): Promise<GrantDocument | null>;
}
