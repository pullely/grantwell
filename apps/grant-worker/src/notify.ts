import { buildIdempotencyKey, enqueueNotification } from "@saas/notifications-client";
import { GRANT_DEADLINE_KIND_LABELS, type GrantDeadlineKind } from "@saas/contracts/grant";
import type { Grant, GrantDeadline } from "@saas/db/grant";
import type { Env } from "./env.js";
import type { ActorContext } from "./router.js";
import { deadlinePublicId, grantPublicId } from "./ids.js";

/**
 * Tell the person responsible that a deadline is theirs. Sent when a deadline
 * is created with an assignee or reassigned. Idempotent per deadline and
 * assignee, so a retried request never emails twice. Advisory: a failed send
 * never fails the write (the console is the record).
 */
export async function sendDeadlineAssigned(
  env: Env,
  requestId: string,
  actor: ActorContext,
  grant: Grant,
  deadline: GrantDeadline,
  consoleUrl: string | null,
): Promise<boolean> {
  if (!deadline.assigneeEmail) return false;
  const result = await enqueueNotification(
    env,
    {
      internalActor: "grant-worker",
      actorSubjectType: actor.subjectType,
      actorSubjectId: actor.subjectId,
      requestId,
    },
    {
      orgId: deadline.orgId,
      category: "product",
      templateKey: "grant.deadline.assigned",
      templateData: {
        grantTitle: grant.title,
        funderName: grant.funderName,
        deadlineTitle: deadline.title,
        kindLabel: GRANT_DEADLINE_KIND_LABELS[deadline.kind as GrantDeadlineKind] ?? deadline.kind,
        dueOn: deadline.dueOn,
        grantUrl: consoleUrl ?? "",
      },
      recipient: { channel: "email", address: deadline.assigneeEmail.toLowerCase() },
      idempotencyKey: buildIdempotencyKey(
        "grant.deadline.assigned",
        grantPublicId(grant.id),
        deadlinePublicId(deadline.id),
        deadline.assigneeEmail.toLowerCase(),
      ),
    },
  );
  return result.ok;
}
