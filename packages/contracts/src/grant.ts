/**
 * Grants (`grant`) bounded context — a nonprofit's grants, the report and
 * deliverable deadlines each award creates, and the award letters stored in R2.
 * The organization IS the nonprofit; its staff (and a freelance grant writer)
 * are its members.
 */

export const GRANT_STATUSES = ["active", "closed", "declined"] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export const GRANT_DEADLINE_KINDS = [
  "narrative_report",
  "financial_report",
  "deliverable",
  "renewal",
  "other",
] as const;
export type GrantDeadlineKind = (typeof GRANT_DEADLINE_KINDS)[number];

export const GRANT_DEADLINE_KIND_LABELS: Record<GrantDeadlineKind, string> = {
  narrative_report: "Narrative report",
  financial_report: "Financial report",
  deliverable: "Deliverable",
  renewal: "Renewal application",
  other: "Other",
};

export const GRANT_DEADLINE_STATUSES = ["open", "submitted", "waived"] as const;
export type GrantDeadlineStatus = (typeof GRANT_DEADLINE_STATUSES)[number];

export const GRANT_DOCUMENT_KINDS = ["award_letter", "report", "other"] as const;
export type GrantDocumentKind = (typeof GRANT_DOCUMENT_KINDS)[number];

/** File types accepted for grant documents. Everything else is refused (415). */
export const GRANT_UPLOAD_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
export type GrantUploadContentType = (typeof GRANT_UPLOAD_CONTENT_TYPES)[number];

/** Per-file ceiling for a grant document (20 MB). */
export const GRANT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export const GRANT_EVENT_TYPES = [
  "grant.created",
  "grant.updated",
  "grant.deadline.created",
  "grant.deadline.updated",
  "grant.deadline.submitted",
  "grant.document.uploaded",
  "grant.reminder.sent",
] as const;
export type GrantEventType = (typeof GRANT_EVENT_TYPES)[number];

// ── Wire shapes ─────────────────────────────────────────────

export interface PublicGrantDeadline {
  id: string;
  grantId: string;
  kind: GrantDeadlineKind;
  title: string;
  /** YYYY-MM-DD */
  dueOn: string;
  assigneeEmail: string | null;
  status: GrantDeadlineStatus;
  submittedAt: string | null;
  /** Submitted on or before its due date; null unless submitted. Derived, never stored. */
  onTime: boolean | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** A deadline in the org-wide list, carrying the grant it belongs to. */
export interface PublicGrantDeadlineWithGrant extends PublicGrantDeadline {
  grantTitle: string;
  funderName: string;
}

export interface PublicGrant {
  id: string;
  orgId: string;
  title: string;
  funderName: string;
  funderContactName: string | null;
  funderContactEmail: string | null;
  /** Integer cents; null when the amount is not yet known. */
  amountCents: number | null;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: GrantStatus;
  restrictions: string;
  leadEmail: string | null;
  notes: string;
  /** The earliest open deadline, if any. */
  nextDeadline: { id: string; title: string; dueOn: string; kind: GrantDeadlineKind } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicGrantDocument {
  id: string;
  grantId: string;
  kind: GrantDocumentKind;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  uploadedAt: string;
}

// ── Requests and responses ───────────────────────────────────

export interface CreateGrantRequest {
  title: string;
  funderName: string;
  funderContactName?: string | null;
  funderContactEmail?: string | null;
  amountCents?: number | null;
  currency?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  status?: GrantStatus;
  restrictions?: string;
  leadEmail?: string | null;
  notes?: string;
}

export type UpdateGrantRequest = Partial<CreateGrantRequest>;

export interface GrantResponse {
  grant: PublicGrant;
}

export interface ListGrantsResponse {
  grants: PublicGrant[];
}

export interface GetGrantResponse {
  grant: PublicGrant;
  deadlines: PublicGrantDeadline[];
  documents: PublicGrantDocument[];
}

export interface CreateGrantDeadlineRequest {
  kind: GrantDeadlineKind;
  title: string;
  dueOn: string;
  assigneeEmail?: string | null;
  notes?: string;
}

export interface UpdateGrantDeadlineRequest {
  kind?: GrantDeadlineKind;
  title?: string;
  dueOn?: string;
  assigneeEmail?: string | null;
  status?: GrantDeadlineStatus;
  notes?: string;
}

export interface GrantDeadlineResponse {
  deadline: PublicGrantDeadline;
}

export interface ListGrantDeadlinesResponse {
  deadlines: PublicGrantDeadlineWithGrant[];
}

export interface GrantDocumentResponse {
  document: PublicGrantDocument;
}

// ── Reminders, the calendar and the on-time rate (GW2) ───────

/**
 * The reminder ladder, latest rung last. `days` is days until due (negative
 * once overdue). A deadline sits on the last rung whose threshold it has
 * reached, so a sweep that missed a day (or a deadline created 20 days out)
 * still lands on the right rung, and each rung is claimed once per due date.
 */
export const GRANT_REMINDER_RUNGS = [
  { rung: "d30", days: 30 },
  { rung: "d14", days: 14 },
  { rung: "d7", days: 7 },
  { rung: "d1", days: 1 },
  { rung: "d0", days: 0 },
  { rung: "late1", days: -1 },
  { rung: "late7", days: -7 },
] as const;
export type GrantReminderRung = (typeof GRANT_REMINDER_RUNGS)[number]["rung"];

/** Rungs that add the grant lead to the assignee: one day out, the day, and every overdue rung. */
export const GRANT_ESCALATION_RUNGS: ReadonlySet<GrantReminderRung> = new Set(["d1", "d0", "late1", "late7"]);

/** How far past due the sweep still looks; older open deadlines are not chased. */
export const GRANT_REMINDER_OVERDUE_HORIZON_DAYS = 30;

/** Whole days from `today` to `dueOn` (both YYYY-MM-DD); negative when past due. */
export function grantDaysUntil(dueOn: string, today: string): number {
  return Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** The rung a deadline `days` from due is on, or null when it is not yet (or no longer) chased. */
export function grantReminderRung(days: number): GrantReminderRung | null {
  if (days > 30 || days < -GRANT_REMINDER_OVERDUE_HORIZON_DAYS) return null;
  let current: GrantReminderRung | null = null;
  for (const r of GRANT_REMINDER_RUNGS) if (days <= r.days) current = r.rung;
  return current;
}

export interface GrantReminderClaim {
  deadlineId: string;
  grantId: string;
  rung: GrantReminderRung;
  dueOn: string;
  daysRemaining: number;
  recipients: string[];
  escalated: boolean;
}

export interface RunGrantRemindersResponse {
  /** The UTC date the ladder was evaluated for. */
  today: string;
  /** Open deadlines on a rung today. */
  considered: number;
  /** Rungs newly claimed (and sent) by this run; a second run the same day claims none. */
  claimed: GrantReminderClaim[];
  /** Deadlines on a rung with nobody to tell (no assignee, no grant lead). */
  skippedNoRecipient: number;
}

export interface GrantDeadlineCalendarResponse {
  /** YYYY-MM */
  month: string;
  /** Every deadline due in the month, whatever its state, due_on ascending. */
  deadlines: PublicGrantDeadlineWithGrant[];
}

export interface GrantStats {
  /** Deadlines still open. */
  open: number;
  /** Open deadlines past their due date. */
  overdue: number;
  /** Open deadlines due in the next 30 days (today included). */
  dueNext30: number;
  submitted: number;
  submittedOnTime: number;
  /** submittedOnTime / submitted, 0–1; null until something has been submitted. */
  onTimeRate: number | null;
}

export interface GrantStatsResponse {
  /** The UTC date "overdue" was judged against. */
  today: string;
  stats: GrantStats;
}

/** Format integer cents as a currency amount for display ("$12,500.00"). */
export function formatGrantAmount(amountCents: number | null, currency: string): string {
  if (amountCents === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }
}

/** Whether a submitted deadline was on time: the submission's UTC date is on or before `dueOn`. */
export function isSubmittedOnTime(dueOn: string, submittedAt: string | null): boolean | null {
  if (!submittedAt) return null;
  return submittedAt.slice(0, 10) <= dueOn;
}
