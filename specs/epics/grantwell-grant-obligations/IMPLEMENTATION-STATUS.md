# grantwell-grant-obligations (GW) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| GW0 — the spec | ✅ landed | #9 |
| GW1 — grants, deadlines and award letters | ✅ shipped — merged f889c37, deploy run 35881994323 green (67/67); stage smoke passed | #10 (GW-2) |
| GW2 — the obligations calendar and escalating reminders | ✅ shipped — merged 9e9e513, deploy run 36609992970 green (27/27); cron `0 13 * * *` registered on stage and prod (read back from Cloudflare); stage smoke: a rung claimed once across two runs | #11 (GW-3) |
| GW3 — the grant writer's portfolio | ✅ shipped — merged d852e20, deploy run 36612931394 green (31/31); stage smoke: a member of three orgs sees exactly those three, the digest sends once a week. The Monday cron's fan-out found no writers on D1 until task GW-6 (see the fix below) | #12 (GW-4), GW-6 |

## Deploy state (2026-09-29)

Every milestone's push-to-`main` deploy run is fully green, judged lane by lane:
35881994323 (GW1, 67/67), 36609992970 (GW2, 27/27), 36612931394 (GW3, 31/31).

Checked on **stage** by scripted smoke (sign-in through `DEBUG_DELIVERY`):
organization create 201; grants, deadlines, award letter SHA-256 round-trip
(GW1); reminders run twice the same day → the 7-day, 1-day and overdue rungs
claimed once, the 1-day and overdue ones copied to the grant lead, the second
run claimed nothing, exactly three `grant.reminder.sent` in the audit trail,
and notifications-worker accepted both emails of an escalated rung (GW2); a
writer invited into three of four organizations sees exactly those three and
six open deadlines, none from the fourth, and this week's digest sends once
then answers `already_sent` (GW3). The console's `/orgs/*/grants`,
`/orgs/*/grants/calendar` and `/portfolio` serve 200.

Checked on **prod**: `/health` 200; every new route answers 401
unauthenticated through api-edge (so the routes are live); `DEBUG_DELIVERY` is
`false` on identity-worker and membership-worker (read back from Cloudflare).
The `0 13 * * *` schedule reads back on `grantwell-grant-worker-stage` and
`-prod`. Nobody can sign in to prod until a sending domain is verified
(runbook trap 27).

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

### GW3 — as built vs. design

- **The portfolio's organizations come from two new membership-worker
  internal routes** (service-binding only, not routed by api-edge):
  `POST /v1/internal/membership/subject-organizations` (a user's active
  organizations, by name) and `POST /v1/internal/membership/multi-org-subjects`
  (every active user in two or more, for the digest). grant-worker never takes
  an org list from the caller, and every grant query is `org_id IN (…)` over
  that list (chunked below D1's 100-bind cap), so a fourth organization's
  deadlines cannot appear. Membership is the authorization: `grant.read` is
  granted to every role, so no per-org policy call is made.
- **The digest address is read by membership-worker with a join to
  `identity_users`**, not through identity-worker. identity-worker answers on
  its public workers.dev hostname on stage and prod (its wrangler template has
  no `workers_dev: false`, unlike every other worker), so a lookup route there
  would have given anyone the email behind a user id. A read-only join across
  contexts inside a bound-only worker was the smaller exposure. The baseline's
  public identity-worker is flagged, not changed.
- **api-edge dispatches `/v1/me/grant-portfolio` before every other facade.**
  cirrus has no `/v1/me` identity facade today (identity lives under
  `/v1/auth/*`); the portfolio is matched first anyway, so a later one cannot
  shadow it.
- **The response carries more than design §2.5**: besides each organization's
  next open deadline, overdue count and on-time rate, it lists every open
  deadline across them due within 30 days (overdue first) and the totals.
- **Digest:** migration `220_grant_digests` (UNIQUE subject + Monday date),
  claimed with `INSERT … ON CONFLICT DO NOTHING RETURNING id` before sending.
  It runs from the same daily 13:00 UTC `scheduled()` on Mondays (UTC) — one
  cron, not two. A writer with nothing open gets no email and nothing is
  claimed. `POST /v1/me/grant-portfolio/digest` sends the signed-in writer this
  week's digest now (same claim), which is how the stage smoke proves
  once-a-week, and the console's "Email me this week's digest" button.
- The notification is filed under the writer's first organization (a
  notification needs an org; the digest spans several).
- The console portfolio is at `/portfolio`, linked from every org's grants page
  ("All my organizations") rather than from the sidebar.

## Fixes after ship

1. **The Monday digest's fan-out found nobody (task GW-6).**
   `multi-org-subjects` joined `identity_users u ON u.id = m.subject_id`, but on
   D1 the membership tables store the subject as the PUBLIC id (`usr_<32 hex>`)
   while `identity_users.id` is the UUID, so the join matched nothing and the
   cron's `runDigest` saw zero writers. The stage smoke only exercised the
   on-demand `POST /v1/me/grant-portfolio/digest` for the signed-in user (its
   address comes from the session, not this join), so the cron path was never
   tested. The join now matches `u.id` against the subject id AND its UUID form
   (the leakbook LB-6 fix, copied as is), so a UUID-shaped subject still
   resolves. `tests/membership-worker/src/grant-portfolio-facts.test.ts` now
   seeds membership with the `usr_` public id, as D1 holds it, and checks both
   forms; the fan-out tests fail on the old join. The first version seeded UUIDs
   on both sides, which is how the bug hid. `subject-organizations` compares
   `m.subject_id` to the caller's own (public) id with no identity join, and is
   unchanged.
