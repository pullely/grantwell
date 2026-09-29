import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { openDb } from "../context.js";
import { notFound, successResponse, unavailable, validationError } from "../http.js";
import { toGrantStats, toPublicDeadlineWithGrant } from "../present.js";
import { runReminders } from "../reminders.js";

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** GET /v1/organizations/{org}/deadlines/calendar?month=YYYY-MM — every deadline due in the month. */
export async function handleDeadlineCalendar(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  const month = new URL(request.url).searchParams.get("month") ?? todayUtc().slice(0, 7);
  const m = month.match(MONTH_RE);
  if (!m) return validationError(requestId, { month: ["A month as YYYY-MM"] });
  const lastDay = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();

  if (!(await allowed(env, actor, orgId, "grant.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const rows = await db.grants.listDeadlines(orgId, {
      from: `${month}-01`,
      through: `${month}-${String(lastDay).padStart(2, "0")}`,
      limit: 500,
    });
    return successResponse({ month, deadlines: rows.map(toPublicDeadlineWithGrant) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/** GET /v1/organizations/{org}/grants/stats — the on-time rate and the overdue count. */
export async function handleGrantStats(env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "grant.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const today = todayUtc();
  try {
    const counts = await db.grants.deadlineCounts([orgId], today);
    return successResponse({ today, stats: toGrantStats(counts.get(orgId)) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/**
 * POST /v1/organizations/{org}/reminders/run — run today's ladder for this org
 * now, exactly as the 13:00 UTC cron would. Safe to repeat: each rung is
 * claimed once, so a second run the same day claims nothing. Writers only.
 */
export async function handleRunReminders(env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "grant.write", requestId))) return notFound(requestId);
  if (!env.PLATFORM_DB) return unavailable(requestId);
  try {
    const result = await runReminders(env, new Date(), { orgId, requestId });
    return successResponse(result, requestId);
  } catch {
    return unavailable(requestId);
  }
}
