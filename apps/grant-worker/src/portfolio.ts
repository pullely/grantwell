import {
  GRANT_DEADLINE_KIND_LABELS,
  GRANT_PORTFOLIO_MAX_ORGS,
  grantDaysUntil,
  type GrantDeadlineKind,
  type GrantPortfolioResponse,
  type SendGrantDigestResponse,
} from "@saas/contracts/grant";
import type { GrantDeadlineWithGrant } from "@saas/db/grant";
import type { Env } from "./env.js";
import type { Db } from "./context.js";
import { openDb } from "./context.js";
import { fetchMultiOrgSubjects, type OrgFact } from "./directory-client.js";
import { orgPublicId } from "./ids.js";
import { sendPortfolioDigest } from "./notify.js";
import { toGrantStats, toPublicDeadlineWithGrant } from "./present.js";

/** Open deadlines read per portfolio (all of the writer's orgs together). */
const OPEN_LIMIT = 1000;
/** How far ahead the portfolio's deadline list (and the digest) looks. */
const HORIZON_DAYS = 30;
/** Lines in one digest email before "and N more". */
const DIGEST_LINES = 25;
const DIGEST_WRITERS = 1000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The Monday (UTC) of `date`'s week, YYYY-MM-DD. */
export function weekOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((day + 6) % 7));
}

/**
 * The portfolio over exactly these organizations — the caller's, as
 * membership-worker reported them. Every query is `org_id IN (…)` over that
 * list, so another organization's deadlines cannot appear.
 */
export async function buildPortfolio(db: Db, orgs: readonly OrgFact[], today: string): Promise<GrantPortfolioResponse> {
  const scoped = orgs.slice(0, GRANT_PORTFOLIO_MAX_ORGS);
  const ids = scoped.map((o) => o.orgId);
  const [counts, open] = await Promise.all([
    db.grants.deadlineCounts(ids, today),
    db.grants.listOpenDeadlinesForOrgs(ids, OPEN_LIMIT),
  ]);
  const byOrg = new Map(scoped.map((o) => [o.orgId, o]));
  const next = new Map<string, GrantDeadlineWithGrant>();
  for (const d of open) if (!next.has(d.orgId)) next.set(d.orgId, d);

  const through = addDays(today, HORIZON_DAYS);
  const deadlines = open
    .filter((d) => d.dueOn <= through && byOrg.has(d.orgId))
    .map((d) => {
      const org = byOrg.get(d.orgId)!;
      return { ...toPublicDeadlineWithGrant(d), orgId: orgPublicId(d.orgId), orgName: org.name, orgSlug: org.slug };
    });

  const organizations = scoped.map((o) => {
    const n = next.get(o.orgId);
    return {
      org: { id: orgPublicId(o.orgId), name: o.name, slug: o.slug },
      stats: toGrantStats(counts.get(o.orgId)),
      nextDeadline: n ? toPublicDeadlineWithGrant(n) : null,
    };
  });

  const sum = { open: 0, overdue: 0, dueNext30: 0, submitted: 0, submittedOnTime: 0 };
  for (const c of counts.values()) {
    sum.open += c.open;
    sum.overdue += c.overdue;
    sum.dueNext30 += c.dueNext30;
    sum.submitted += c.submitted;
    sum.submittedOnTime += c.submittedOnTime;
  }
  return { today, organizations, deadlines, totals: toGrantStats(sum), truncated: orgs.length > scoped.length };
}

/** The digest's lines: overdue first, then the next 30 days, one per deadline. */
export function digestLines(portfolio: GrantPortfolioResponse): string[] {
  return portfolio.deadlines.map((d) => {
    const days = grantDaysUntil(d.dueOn, portfolio.today);
    const when = days < 0 ? `OVERDUE ${-days}d` : days === 0 ? "due today" : `due ${d.dueOn}`;
    const kind = GRANT_DEADLINE_KIND_LABELS[d.kind as GrantDeadlineKind] ?? d.kind;
    return `${d.orgName} — ${d.title} (${kind}, ${d.grantTitle}): ${when}${d.assigneeEmail ? ` · ${d.assigneeEmail}` : ""}`;
  });
}

export interface DigestTarget {
  subjectId: string;
  address: string;
  organizations: OrgFact[];
}

/**
 * Claim this writer's digest for the week, then send it. Nothing is claimed
 * (or sent) when fewer than two organizations remain or nothing is open, so a
 * writer with no open work gets no email.
 */
export async function sendDigestTo(
  env: Env,
  db: Db,
  target: DigestTarget,
  now: Date,
  requestId: string,
): Promise<SendGrantDigestResponse> {
  const today = now.toISOString().slice(0, 10);
  const week = weekOf(today);
  if (target.organizations.length < 2) return { weekOf: week, sent: false, reason: "fewer_than_two_organizations" };
  const portfolio = await buildPortfolio(db, target.organizations, today);
  if (portfolio.totals.open === 0) return { weekOf: week, sent: false, reason: "nothing_open" };

  const claimed = await db.grants.claimDigest({
    id: crypto.randomUUID(),
    subjectId: target.subjectId,
    weekOf: week,
    address: target.address.toLowerCase(),
    orgCount: portfolio.organizations.length,
    sentAt: now.toISOString(),
  });
  if (!claimed) return { weekOf: week, sent: false, reason: "already_sent" };

  const lines = digestLines(portfolio);
  try {
    await sendPortfolioDigest(env, requestId, {
      subjectId: target.subjectId,
      address: target.address,
      weekOf: week,
      // The notification is filed under the writer's first organization: a
      // notification needs one, and the digest spans them all.
      orgId: target.organizations[0]!.orgId,
      orgCount: portfolio.organizations.length,
      open: portfolio.totals.open,
      overdue: portfolio.totals.overdue,
      dueNext30: portfolio.totals.dueNext30,
      lines: lines.slice(0, DIGEST_LINES),
      more: Math.max(0, lines.length - DIGEST_LINES),
    });
  } catch {
    // Advisory, like a reminder rung: the claim stands (at most once a week).
  }
  return { weekOf: week, sent: true, organizations: portfolio.organizations.length, lines: lines.length };
}

export interface DigestRun {
  weekOf: string;
  writers: number;
  sent: number;
  skipped: number;
}

/**
 * The Monday sweep: every member of two or more organizations gets one digest
 * for the week. A directory failure stops the run (nothing is claimed blind).
 */
export async function runDigest(env: Env, now: Date, requestId = `cron_digest_${now.getTime()}`): Promise<DigestRun> {
  const today = now.toISOString().slice(0, 10);
  const run: DigestRun = { weekOf: weekOf(today), writers: 0, sent: 0, skipped: 0 };
  if (!env.MEMBERSHIP_WORKER) return run;
  const writers = await fetchMultiOrgSubjects(env.MEMBERSHIP_WORKER, 2, DIGEST_WRITERS, requestId);
  if (!writers || writers.length === 0) return run;
  run.writers = writers.length;

  const db = openDb(env);
  if (!db) return run;
  try {
    for (const writer of writers) {
      if (!writer.email) {
        run.skipped += 1;
        continue;
      }
      const result = await sendDigestTo(
        env,
        db,
        { subjectId: writer.subjectId, address: writer.email, organizations: writer.organizations },
        now,
        requestId,
      );
      if (result.sent) run.sent += 1;
      else run.skipped += 1;
    }
  } finally {
    await db.dispose();
  }
  return run;
}
