import {
  isSubmittedOnTime,
  type GrantDeadlineKind,
  type GrantDeadlineStatus,
  type GrantDocumentKind,
  type GrantStatus,
  type PublicGrant,
  type PublicGrantDeadline,
  type PublicGrantDeadlineWithGrant,
  type PublicGrantDocument,
} from "@saas/contracts/grant";
import type { Grant, GrantDeadline, GrantDeadlineWithGrant, GrantDocument } from "@saas/db/grant";
import { deadlinePublicId, documentPublicId, grantPublicId, orgPublicId } from "./ids.js";

export function toPublicDeadline(d: GrantDeadline): PublicGrantDeadline {
  return {
    id: deadlinePublicId(d.id),
    grantId: grantPublicId(d.grantId),
    kind: d.kind as GrantDeadlineKind,
    title: d.title,
    dueOn: d.dueOn,
    assigneeEmail: d.assigneeEmail,
    status: d.status as GrantDeadlineStatus,
    submittedAt: d.submittedAt,
    onTime: d.status === "submitted" ? isSubmittedOnTime(d.dueOn, d.submittedAt) : null,
    notes: d.notes,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function toPublicDeadlineWithGrant(d: GrantDeadlineWithGrant): PublicGrantDeadlineWithGrant {
  return { ...toPublicDeadline(d), grantTitle: d.grantTitle, funderName: d.funderName };
}

export function toPublicGrant(g: Grant, next: GrantDeadline | null): PublicGrant {
  return {
    id: grantPublicId(g.id),
    orgId: orgPublicId(g.orgId),
    title: g.title,
    funderName: g.funderName,
    funderContactName: g.funderContactName,
    funderContactEmail: g.funderContactEmail,
    amountCents: g.amountCents,
    currency: g.currency,
    periodStart: g.periodStart,
    periodEnd: g.periodEnd,
    status: g.status as GrantStatus,
    restrictions: g.restrictions,
    leadEmail: g.leadEmail,
    notes: g.notes,
    nextDeadline: next
      ? { id: deadlinePublicId(next.id), title: next.title, dueOn: next.dueOn, kind: next.kind as GrantDeadlineKind }
      : null,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

export function toPublicDocument(d: GrantDocument): PublicGrantDocument {
  return {
    id: documentPublicId(d.id),
    grantId: grantPublicId(d.grantId),
    kind: d.kind as GrantDocumentKind,
    filename: d.filename,
    contentType: d.contentType,
    byteSize: d.byteSize,
    sha256: d.sha256,
    uploadedAt: d.uploadedAt,
  };
}
