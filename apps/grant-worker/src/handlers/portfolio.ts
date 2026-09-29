import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { openDb } from "../context.js";
import { fetchSubjectOrganizations } from "../directory-client.js";
import { errorResponse, successResponse, unavailable } from "../http.js";
import { buildPortfolio, sendDigestTo } from "../portfolio.js";

/**
 * GET /v1/me/grant-portfolio — the caller's organizations (from
 * membership-worker, never from a query parameter) with each one's next open
 * deadline, overdue count and on-time rate, and every open deadline across
 * them due within 30 days. Membership is the authorization: every role reads
 * grants (`grant.read` is granted to all four), and an organization the caller
 * is not in is never queried.
 */
export async function handleGetPortfolio(env: Env, requestId: string, actor: ActorContext): Promise<Response> {
  if (!env.MEMBERSHIP_WORKER) return unavailable(requestId);
  const orgs = await fetchSubjectOrganizations(env.MEMBERSHIP_WORKER, { id: actor.subjectId, type: actor.subjectType }, requestId);
  if (!orgs) return unavailable(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const portfolio = await buildPortfolio(db, orgs, new Date().toISOString().slice(0, 10));
    return successResponse(portfolio, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/**
 * POST /v1/me/grant-portfolio/digest — send the caller this week's digest now
 * (to the signed-in address), exactly as the Monday sweep would. Claimed per
 * writer per week, so a second call — or the Monday sweep after it — sends
 * nothing more.
 */
export async function handleSendMyDigest(request: Request, env: Env, requestId: string, actor: ActorContext): Promise<Response> {
  const email = request.headers.get("x-actor-email");
  if (actor.subjectType !== "user" || !email) {
    return errorResponse("forbidden", "Only a signed-in user has a digest", 403, requestId);
  }
  if (!env.MEMBERSHIP_WORKER) return unavailable(requestId);
  const orgs = await fetchSubjectOrganizations(env.MEMBERSHIP_WORKER, { id: actor.subjectId, type: actor.subjectType }, requestId);
  if (!orgs) return unavailable(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const result = await sendDigestTo(env, db, { subjectId: actor.subjectId, address: email, organizations: orgs }, new Date(), requestId);
    return successResponse(result, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
