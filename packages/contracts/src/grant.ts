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
