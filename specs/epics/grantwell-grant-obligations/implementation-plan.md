# grantwell-grant-obligations — implementation plan

Milestones land in order. Each is one or more tasks, each task one pull
request, each pull request landed with `orun pr land`. A milestone is marked
✅ here when its "done when" list is true, and recorded in
`IMPLEMENTATION-STATUS.md`.

A workspace can mint only 200 brokered credentials per rolling 24 hours, and
every CI job that deploys spends one. The bootstrap, this spec and GW1 fit in
one day; GW2 and GW3 land on the next. Each milestone's tests run green locally
before its pull request opens, because every push to a pull request spends
mints.

## GW0 — the spec

This doc set, merged to `main` and attached to the epic with `orun spec push`.

**Done when**
- the five documents are on `main`
- `orun spec list --epic grantwell-grant-obligations` shows them

## GW1 — grants, deadlines and award letters

The `grant` bounded context end to end. Migration `200_grant_core`
(`grant_grants`, `grant_deadlines`, `grant_documents`) in `packages/db` with its
repository; the wire types in `packages/contracts/src/grant.ts` and a
`GrantClient` in the SDK; `apps/grant-worker` (grants, deadlines, the org-wide
deadline list, award-letter upload/download to R2, the assignment email, audit
events), depending on `db-migrate` so its migration always deploys first; the
api-edge grant facade and binding; `grant.read`/`grant.write` in the policy
engine; the `grant.deadline.assigned` template and `grant-worker` on the
notifications allow-list; the `infra/terraform/cloudflare-r2` component; the
console grants list and grant page. The Solo profile is turned off.

It also carries two baseline fixes every cirrus product needs before its first
audited write works on D1: the tested `cirrus-d1-fix.patch` (events/audit and
membership SQL that SQLite cannot run — without it no organization can be
created) and a redeploy marker on every worker's `component.yaml`, because a
shared-package change does not redeploy the workers that bundle it.

**Done when**
- migration `200_grant_core` is applied on stage and prod
- on stage, a signed-in user creates an organization (201), creates a grant, adds two deadlines, and uploads a PDF award letter that downloads with the same SHA-256
- marking a deadline submitted on or before its due date reports `onTime: true`; after it, `false`
- a non-member reading the grant gets 404; a viewer creating one gets 404
- `tests/grant-worker` runs the worker over a real SQLite engine and is green in CI

## GW2 — the obligations calendar and escalating reminders

Migration `210_grant_reminders`; a `scheduled()` handler on `grant-worker` with
a daily cron (`0 13 * * *`); the ladder 30/14/7/1/0 days before and 1/7 days
after `due_on` to the assignee, adding the grant's `lead_email` (or the org
owners when it is unset) from the 1-day rung and on every overdue rung; each
rung claimed with `INSERT … ON CONFLICT DO NOTHING RETURNING id` before it is
sent; `grant.reminder.sent` audit events; the `grant.deadline.reminder`
template; the console month calendar and the on-time report rate.

**Done when**
- a rung that is due sends exactly once across two cron ticks run back to back (tested with an injected clock over real SQLite)
- a submitted or waived deadline sends nothing further; moving `due_on` re-arms the ladder
- an overdue deadline's reminder goes to the assignee and the grant lead
- the worker's deploy log lists the `0 13 * * *` schedule on stage and prod
- the calendar renders every open deadline of the month

## GW3 — the grant writer's portfolio

`GET /v1/me/grant-portfolio` in `grant-worker`, reading the caller's
memberships from membership-worker and aggregating per org (next open
deadline, overdue count, on-time rate); the console portfolio page; a weekly
digest email (`grant.portfolio.digest`, Mondays) to every member who belongs to
two or more organizations.

**Done when**
- a user who belongs to three organizations sees exactly those three in one response, and a fourth organization's deadlines never appear
- the digest is sent once per writer per week (claimed like a reminder rung)
- the console portfolio page links each row to that org's grant page

## Sequencing note

GW1 is the record everything else reads: GW2's ladder is derived from
`grant_deadlines` rows and GW3 aggregates them, so GW1 lands first and alone,
with the D1 fix that makes organization create work at all. GW2 and GW3 are
independent of each other but share `grant-worker`'s `scheduled()` entry
point, so they land in order to keep one cron handler. Award-letter extraction
waits on a model credential (GW-B) and is not sequenced here.
