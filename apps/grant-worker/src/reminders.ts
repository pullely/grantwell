import {
  GRANT_ESCALATION_RUNGS,
  GRANT_REMINDER_OVERDUE_HORIZON_DAYS,
  grantDaysUntil,
  grantReminderRung,
  type GrantReminderClaim,
  type RunGrantRemindersResponse,
} from "@saas/contracts/grant";
import type { ReminderCandidate } from "@saas/db/grant";
import type { Env } from "./env.js";
import { recordAudit, type AuditActor } from "./audit.js";
import { openDb } from "./context.js";
import { deadlinePublicId, grantPublicId } from "./ids.js";
import { sendDeadlineReminder } from "./notify.js";

/** The sweep's own actor in the audit trail. */
export const REMINDER_ACTOR: AuditActor = { type: "system", id: "grant-reminders" };

const BATCH = 1000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Who hears about a rung: the assignee always; the grant lead too from one day
 * out and on every overdue rung. With no assignee the lead hears every rung
 * (somebody must). Addresses are lower-cased and de-duplicated, assignee first.
 */
export function reminderRecipients(
  candidate: Pick<ReminderCandidate, "assigneeEmail" | "grantLeadEmail">,
  escalate: boolean,
): { recipients: string[]; escalated: boolean } {
  const assignee = candidate.assigneeEmail?.trim().toLowerCase() || null;
  const lead = candidate.grantLeadEmail?.trim().toLowerCase() || null;
  const recipients: string[] = [];
  if (assignee) recipients.push(assignee);
  const addLead = lead !== null && (escalate || assignee === null) && lead !== assignee;
  if (addLead) recipients.push(lead);
  return { recipients, escalated: addLead && assignee !== null };
}

export interface RunRemindersOptions {
  /** Only this org's deadlines (the on-demand run). The cron passes none. */
  orgId?: string | undefined;
  requestId?: string | undefined;
}

/**
 * One pass of the reminder ladder for `now`'s UTC date. For every open
 * deadline of an active grant due within [today - 30, today + 30], find the
 * rung it is on; claim (deadline, rung, due_on) with an insert that returns a
 * row only the first time; send only on a claim. Two sweeps back to back, or
 * two at once, send each rung once. Moving due_on re-arms the ladder (the new
 * date is a new key); a submitted or waived deadline is no longer a candidate.
 */
export async function runReminders(env: Env, now: Date, opts: RunRemindersOptions = {}): Promise<RunGrantRemindersResponse> {
  const today = now.toISOString().slice(0, 10);
  const result: RunGrantRemindersResponse = { today, considered: 0, claimed: [], skippedNoRecipient: 0 };
  const db = openDb(env);
  if (!db) return result;
  const requestId = opts.requestId ?? `cron_${now.getTime()}`;
  const nowIso = now.toISOString();

  try {
    const candidates = await db.grants.listReminderCandidates({
      from: addDays(today, -GRANT_REMINDER_OVERDUE_HORIZON_DAYS),
      through: addDays(today, 30),
      orgId: opts.orgId,
      limit: BATCH,
    });

    for (const candidate of candidates) {
      const daysRemaining = grantDaysUntil(candidate.dueOn, today);
      const rung = grantReminderRung(daysRemaining);
      if (rung === null) continue;
      result.considered += 1;

      const { recipients, escalated } = reminderRecipients(candidate, GRANT_ESCALATION_RUNGS.has(rung));
      if (recipients.length === 0) {
        // Not claimed: assigning someone later still gets today's rung out.
        result.skippedNoRecipient += 1;
        continue;
      }

      const claimed = await db.grants.claimReminder({
        id: crypto.randomUUID(),
        orgId: candidate.orgId,
        deadlineId: candidate.id,
        rung,
        dueOn: candidate.dueOn,
        recipients: recipients.join(","),
        escalated,
        sentAt: nowIso,
      });
      if (!claimed) continue;

      for (const address of recipients) {
        try {
          await sendDeadlineReminder(env, requestId, candidate, {
            rung,
            daysRemaining,
            address,
            role: address === candidate.assigneeEmail?.trim().toLowerCase() ? "assignee" : "lead",
          });
        } catch {
          // Advisory: the claim stands (at most once); the audit row records the attempt.
        }
      }

      const claim: GrantReminderClaim = {
        deadlineId: deadlinePublicId(candidate.id),
        grantId: grantPublicId(candidate.grantId),
        rung,
        dueOn: candidate.dueOn,
        daysRemaining,
        recipients,
        escalated,
      };
      result.claimed.push(claim);

      await recordAudit(db.executor, {
        type: "grant.reminder.sent",
        orgId: candidate.orgId,
        actor: REMINDER_ACTOR,
        requestId,
        subjectKind: "grant_deadline",
        subjectId: candidate.id,
        subjectName: candidate.title,
        description:
          daysRemaining < 0
            ? `Overdue reminder (${rung}) for "${candidate.title}" on "${candidate.grantTitle}", due ${candidate.dueOn}, sent to ${recipients.join(", ")}`
            : `${rung} reminder for "${candidate.title}" on "${candidate.grantTitle}", due ${candidate.dueOn}, sent to ${recipients.join(", ")}`,
        payload: { ...claim },
        occurredAt: nowIso,
      });
    }
  } finally {
    await db.dispose();
  }
  return result;
}
