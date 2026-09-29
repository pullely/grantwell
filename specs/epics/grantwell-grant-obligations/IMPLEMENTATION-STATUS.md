# grantwell-grant-obligations (GW) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| GW0 — the spec | ✅ landed | #9 |
| GW1 — grants, deadlines and award letters | ✅ shipped — merged f889c37, deploy run 35881994323 green (67/67); stage smoke passed | #10 (GW-2) |
| GW2 — the obligations calendar and escalating reminders | in review | GW-3 |
| GW3 — the grant writer's portfolio | | |

## Departures from the design

### GW1 — baseline departures carried with the first feature

- **The cirrus D1 fix (runbook trap 16).** GW1 applies
  `factory/patches/cirrus-d1-fix.patch`: the baseline's
  `EventsRepository.appendEventWithAudit` and the membership repository used
  Postgres-only SQL (a data-modifying CTE, `row_to_json`, `FULL JOIN`) that
  SQLite rejects, so organization create answered 503 and every audited write
  was lost on D1. The patch rewrites those paths as portable statements and adds
  a real-SQLite schema test in `tests/db`. Not product code; a baseline repair.
- **Redeploy markers (trap 17).** Every worker's `component.yaml` carries a
  `# orun: redeploy GW1 …` line, because `packages/db`, `packages/policy-engine`
  and `packages/contracts` changed and a worker only redeploys when its own
  component changes.
- **Solo profile off.** `SOLO_MODE=false` on api-edge, identity-worker,
  membership-worker and the console (design §3).

### GW1 — as built vs. design

- `grant-worker` writes its audit rows with its own two portable statements
  (`appendEvent` + `INSERT … SELECT` into `events_audit_entries`) rather than the
  patched `appendEventWithAudit`, so its trail does not depend on the baseline
  path either way.
- The assignment email carries no console link: the worker does not know the
  console's origin. The email names the grant, funder, deadline and due date.
- A CHECK constraint holds `submitted_at` to `status = 'submitted'` in the
  schema itself, beyond what design §1.2 required.
- Every repository write whose outcome is read uses `RETURNING` (the D1
  executor's `rowCount` is 0 for a bare write — runbook trap 22), pinned by
  `tests/grant-worker/src/d1-rowcount.test.ts` over the real executor.

### GW2 — as built vs. design

- **The ladder is "the last rung reached", not "exactly on the day".** A
  deadline sits on the last of 30/14/7/1/0 (and late 1/7) whose threshold it
  has reached (`grantReminderRung` in `packages/contracts/src/grant.ts`), so a
  deadline created 20 days out is chased at once on the 30-day rung and a
  missed tick never skips a rung. Each rung is still claimed once per
  (deadline, rung, due date) — `INSERT … ON CONFLICT DO NOTHING RETURNING id`,
  counted by returned rows (trap 22).
- **The sweep window is due dates from 30 days past to 30 days ahead**, on open
  deadlines of `active` grants only. A deadline more than 30 days late is no
  longer chased; a closed or declined grant's deadlines are not chased.
- **Escalation goes to the grant's `lead_email` only.** Design §2.4 and the
  plan also named the org owners as a fallback when no lead is set; membership
  holds no email addresses (identity does), so that needs a second service
  hop and is deferred. With no assignee, the lead receives every rung; with
  neither, the rung is left unclaimed (and goes out once someone is assigned).
- **An on-demand run: `POST /v1/organizations/{org}/reminders/run`**
  (`grant.write`) runs the same sweep for one org and returns what it claimed.
  It is how the stage smoke proves claim-once without waiting for 13:00 UTC,
  and it is repeat-safe by construction. Not in design §2.4.
- The cron is declared at the top level of `wrangler.template.jsonc`
  (inherited by stage and prod), the same way the baseline's metering-worker
  declares its own.
- `grant_reminders` carries an `escalated` flag beyond design §1.4, so the
  audit trail and the table both say when the lead was copied.
