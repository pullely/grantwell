import { GRANT_STATUSES } from "@saas/contracts/grant";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { recordAudit } from "../audit.js";
import { nowIso, openDb } from "../context.js";
import { notFound, successResponse, unavailable, validationError } from "../http.js";
import { actorSubjectUuid, grantPublicId } from "../ids.js";
import { toPublicDeadline, toPublicDocument, toPublicGrant } from "../present.js";
import { validateGrantBody } from "../validate.js";

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

export async function handleListGrants(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  const status = new URL(request.url).searchParams.get("status") ?? undefined;
  if (status !== undefined && !(GRANT_STATUSES as readonly string[]).includes(status)) {
    return validationError(requestId, { status: [`One of ${GRANT_STATUSES.join(", ")}`] });
  }
  if (!(await allowed(env, actor, orgId, "grant.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const grants = await db.grants.listGrants(orgId, status);
    const next = await db.grants.nextOpenDeadlines(orgId, grants.map((g) => g.id));
    return successResponse({ grants: grants.map((g) => toPublicGrant(g, next.get(g.id) ?? null)) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleCreateGrant(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  const validation = validateGrantBody(parsed.body, null);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "grant.write", requestId))) return notFound(requestId);

  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const grant = await db.grants.createGrant({
      id: crypto.randomUUID(),
      orgId,
      ...validation.value,
      createdBy: actorSubjectUuid(actor.subjectId),
      now,
    });
    await recordAudit(db.executor, {
      type: "grant.created",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "grant",
      subjectId: grant.id,
      subjectName: grant.title,
      description: `Recorded the grant "${grant.title}" from ${grant.funderName}`,
      payload: {
        grantId: grantPublicId(grant.id),
        funderName: grant.funderName,
        amountCents: grant.amountCents,
        currency: grant.currency,
        status: grant.status,
      },
      occurredAt: now,
    });
    return successResponse({ grant: toPublicGrant(grant, null) }, requestId, 201);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleGetGrant(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  grantId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "grant.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const grant = await db.grants.getGrant(orgId, grantId);
    if (!grant) return notFound(requestId);
    const [deadlines, documents] = await Promise.all([
      db.grants.listDeadlinesForGrant(orgId, grantId),
      db.grants.listDocuments(orgId, grantId),
    ]);
    const next = deadlines.find((d) => d.status === "open") ?? null;
    return successResponse(
      {
        grant: toPublicGrant(grant, next),
        deadlines: deadlines.map(toPublicDeadline),
        documents: documents.map(toPublicDocument),
      },
      requestId,
    );
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleUpdateGrant(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  grantId: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  if (!(await allowed(env, actor, orgId, "grant.write", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const current = await db.grants.getGrant(orgId, grantId);
    if (!current) return notFound(requestId);
    const validation = validateGrantBody(parsed.body, current);
    if (!validation.valid) return validationError(requestId, validation.fields);
    const grant = await db.grants.updateGrant(orgId, grantId, validation.value, now);
    if (!grant) return notFound(requestId);

    const changed = (Object.keys(validation.value) as (keyof typeof validation.value)[]).filter(
      (k) => validation.value[k] !== current[k],
    );
    await recordAudit(db.executor, {
      type: "grant.updated",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "grant",
      subjectId: grant.id,
      subjectName: grant.title,
      description: `Updated the grant "${grant.title}"${changed.length ? ` (${changed.join(", ")})` : ""}`,
      payload: { grantId: grantPublicId(grant.id), changed, status: grant.status },
      occurredAt: now,
    });
    const deadlines = await db.grants.listDeadlinesForGrant(orgId, grantId);
    return successResponse(
      { grant: toPublicGrant(grant, deadlines.find((d) => d.status === "open") ?? null) },
      requestId,
    );
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
