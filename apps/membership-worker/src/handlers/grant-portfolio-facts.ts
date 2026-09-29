import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/d1";
import { errorResponse, successResponse, validationError } from "../http.js";

// Grantwell GW3 — the membership facts the grant writer's portfolio needs.
// Service-binding only (grant-worker); api-edge routes neither path. Both
// read this context's own tables and return active organizations only.

export interface SubjectOrganizationFact {
  /** Organization UUID. */
  orgId: string;
  name: string;
  slug: string;
}

export interface MultiOrgSubjectFact {
  subjectId: string;
  subjectType: string;
  /** The user's address, for the digest. */
  email: string;
  organizations: SubjectOrganizationFact[];
}

const MAX_SUBJECTS = 1000;

type Row = Record<string, unknown>;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * POST /v1/internal/membership/subject-organizations
 * `{ subject: { type, id } }` → `{ organizations: [{ orgId, name, slug }] }` —
 * every active organization the subject is an active member of, by name.
 */
export async function handleSubjectOrganizations(request: Request, env: Env, requestId: string): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const body = await readJson(request);
  if (!body) return validationError(requestId, { body: ["Request body must be a JSON object"] });
  const subject = body.subject as Record<string, unknown> | undefined;
  if (!subject || typeof subject !== "object" || typeof subject.id !== "string" || subject.id.length === 0) {
    return validationError(requestId, { "subject.id": ["Required"] });
  }
  if (subject.type !== undefined && typeof subject.type !== "string") {
    return validationError(requestId, { "subject.type": ["Must be a string"] });
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const result = await executor.execute<Row>(
      `SELECT o.id, o.name, o.slug
         FROM membership_organization_members m
         JOIN membership_organizations o ON o.id = m.org_id
        WHERE m.subject_id = $1 AND m.status = 'active' AND o.status = 'active'
        ORDER BY o.name ASC, o.id ASC`,
      [subject.id],
    );
    const organizations: SubjectOrganizationFact[] = result.rows.map((r) => ({
      orgId: String(r.id),
      name: String(r.name),
      slug: String(r.slug),
    }));
    return successResponse({ organizations }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await executor.dispose();
  }
}

/**
 * POST /v1/internal/membership/multi-org-subjects
 * `{ minOrganizations?: number (default 2), limit?: number }` →
 * `{ subjects: [{ subjectId, subjectType, email, organizations }] }` — every
 * active user who is an active member of at least `minOrganizations` active
 * organizations.
 *
 * The address is read from `identity_users` in the same D1 database — a
 * read-only join across contexts, deliberately here rather than a lookup route
 * on identity-worker: identity-worker is reachable on its workers.dev hostname
 * (api-edge proxies /v1/auth/* to it), so an internal route there would hand
 * any caller the email behind a user id. membership-worker is bound-only.
 */
export async function handleMultiOrgSubjects(request: Request, env: Env, requestId: string): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const body = (await readJson(request)) ?? {};
  const min = body.minOrganizations === undefined ? 2 : body.minOrganizations;
  const limit = body.limit === undefined ? MAX_SUBJECTS : body.limit;
  if (typeof min !== "number" || !Number.isInteger(min) || min < 1 || min > 100) {
    return validationError(requestId, { minOrganizations: ["An integer from 1 to 100"] });
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_SUBJECTS) {
    return validationError(requestId, { limit: [`An integer from 1 to ${MAX_SUBJECTS}`] });
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const result = await executor.execute<Row>(
      `WITH writers AS (
         SELECT m.subject_id
           FROM membership_organization_members m
           JOIN membership_organizations o ON o.id = m.org_id
          WHERE m.status = 'active' AND m.subject_type = 'user' AND o.status = 'active'
          GROUP BY m.subject_id
         HAVING COUNT(DISTINCT m.org_id) >= $1
          ORDER BY m.subject_id
          LIMIT $2
       )
       SELECT m.subject_id, m.subject_type, u.email, o.id AS org_id, o.name, o.slug
         FROM membership_organization_members m
         JOIN writers w ON w.subject_id = m.subject_id
         JOIN identity_users u ON u.id = m.subject_id AND u.status = 'active'
         JOIN membership_organizations o ON o.id = m.org_id
        WHERE m.status = 'active' AND o.status = 'active'
        ORDER BY m.subject_id ASC, o.name ASC, o.id ASC`,
      [min, limit],
    );
    const bySubject = new Map<string, MultiOrgSubjectFact>();
    for (const r of result.rows) {
      const id = String(r.subject_id);
      let s = bySubject.get(id);
      if (!s) {
        s = { subjectId: id, subjectType: String(r.subject_type), email: String(r.email), organizations: [] };
        bySubject.set(id, s);
      }
      s.organizations.push({ orgId: String(r.org_id), name: String(r.name), slug: String(r.slug) });
    }
    return successResponse({ subjects: [...bySubject.values()] }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await executor.dispose();
  }
}
