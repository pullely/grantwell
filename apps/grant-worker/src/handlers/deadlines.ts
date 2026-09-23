import { GRANT_DEADLINE_STATUSES, isSubmittedOnTime } from "@saas/contracts/grant";
import type { Grant, GrantDeadline } from "@saas/db/grant";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { recordAudit } from "../audit.js";
import { nowIso, openDb } from "../context.js";
import { errorResponse, notFound, successResponse, unavailable, validationError } from "../http.js";
import { actorSubjectUuid, deadlinePublicId, grantPublicId } from "../ids.js";
import { sendDeadlineAssigned } from "../notify.js";
import { toPublicDeadline, toPublicDeadlineWithGrant } from "../present.js";
import { isCalendarDate, validateDeadlineCreate, validateDeadlinePatch } from "../validate.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Email the assignee; never lets a notification failure reach the caller. */
async function notifyAssignee(
  env: Env,
  requestId: string,
  actor: ActorContext,
  grant: Grant,
  deadline: GrantDeadline,
): Promise<boolean> {
  try {
    return await sendDeadlineAssigned(env, requestId, actor, grant, deadline, null);
  } catch {
    return false;
  }
}

export async function handleListDeadlines(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const status = params.get("status") ?? "open";
  if (status !== "all" && !(GRANT_DEADLINE_STATUSES as readonly string[]).includes(status)) {
    return validationError(requestId, { status: [`One of all, ${GRANT_DEADLINE_STATUSES.join(", ")}`] });
  }
  const through = params.get("through") ?? undefined;
  if (through !== undefined && !isCalendarDate(through)) {
    return validationError(requestId, { through: ["A date as YYYY-MM-DD"] });
  }
  const limitRaw = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;

  if (!(await allowed(env, actor, orgId, "grant.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const rows = await db.grants.listDeadlines(orgId, {
      status: status === "all" ? undefined : status,
      through,
      limit,
    });
    return successResponse({ deadlines: rows.map(toPublicDeadlineWithGrant) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleCreateDeadline(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  grantId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const validation = validateDeadlineCreate(body);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "grant.write", requestId))) return notFound(requestId);

  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const grant = await db.grants.getGrant(orgId, grantId);
    if (!grant) return notFound(requestId);
    if (grant.status === "declined") {
      return errorResponse("conflict", "A declined grant creates no obligations", 409, requestId, {
        reason: "grant_declined",
      });
    }
    const deadline = await db.grants.createDeadline({
      id: crypto.randomUUID(),
      orgId,
      grantId,
      ...validation.value,
      createdBy: actorSubjectUuid(actor.subjectId),
      now,
    });
    await recordAudit(db.executor, {
      type: "grant.deadline.created",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "grant_deadline",
      subjectId: deadline.id,
      subjectName: deadline.title,
      description: `Added "${deadline.title}" due ${deadline.dueOn} to "${grant.title}"`,
      payload: {
        grantId: grantPublicId(grant.id),
        deadlineId: deadlinePublicId(deadline.id),
        kind: deadline.kind,
        dueOn: deadline.dueOn,
        assigneeEmail: deadline.assigneeEmail,
      },
      occurredAt: now,
    });
    const notified = deadline.assigneeEmail ? await notifyAssignee(env, requestId, actor, grant, deadline) : false;
    return successResponse({ deadline: toPublicDeadline(deadline), assigneeNotified: notified }, requestId, 201);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleUpdateDeadline(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  grantId: string,
  deadlineId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const validation = validateDeadlinePatch(body);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "grant.write", requestId))) return notFound(requestId);

  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const grant = await db.grants.getGrant(orgId, grantId);
    if (!grant) return notFound(requestId);
    const current = await db.grants.getDeadline(orgId, grantId, deadlineId);
    if (!current) return notFound(requestId);

    const patch = validation.value;
    const status = patch.status ?? current.status;
    // submitted_at is set exactly while the deadline is submitted: kept on a
    // repeat "submitted", stamped on the transition, cleared on reopen/waive.
    const submittedAt = status === "submitted" ? (current.submittedAt ?? now) : null;
    const updated = await db.grants.updateDeadline(orgId, grantId, deadlineId, {
      kind: patch.kind ?? current.kind,
      title: patch.title ?? current.title,
      dueOn: patch.dueOn ?? current.dueOn,
      assigneeEmail: patch.assigneeEmail === undefined ? current.assigneeEmail : patch.assigneeEmail,
      status,
      submittedAt,
      notes: patch.notes ?? current.notes,
      now,
    });
    if (!updated) return notFound(requestId);

    const becameSubmitted = current.status !== "submitted" && updated.status === "submitted";
    const onTime = isSubmittedOnTime(updated.dueOn, updated.submittedAt);
    await recordAudit(db.executor, {
      type: becameSubmitted ? "grant.deadline.submitted" : "grant.deadline.updated",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "grant_deadline",
      subjectId: updated.id,
      subjectName: updated.title,
      description: becameSubmitted
        ? `Submitted "${updated.title}" for "${grant.title}" ${onTime ? "on time" : "late"} (due ${updated.dueOn})`
        : `Updated "${updated.title}" for "${grant.title}"`,
      payload: {
        grantId: grantPublicId(grant.id),
        deadlineId: deadlinePublicId(updated.id),
        status: updated.status,
        dueOn: updated.dueOn,
        from: { status: current.status, dueOn: current.dueOn, assigneeEmail: current.assigneeEmail },
        onTime: updated.status === "submitted" ? onTime : null,
      },
      occurredAt: now,
    });

    const reassigned = updated.assigneeEmail !== null && updated.assigneeEmail !== current.assigneeEmail;
    const notified = reassigned && updated.status === "open" ? await notifyAssignee(env, requestId, actor, grant, updated) : false;
    return successResponse({ deadline: toPublicDeadline(updated), assigneeNotified: notified }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
