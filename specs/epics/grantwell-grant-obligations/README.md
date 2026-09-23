# Epic: grantwell-grant-obligations (GW)

**Small nonprofits win grants and then lose them on the obligations that come
after the award: a narrative report due eleven months out, a financial report
the executive director meant to calendar, a deliverable promised in the award
letter that nobody but the ED ever read. Missing one puts the renewal at risk,
and the tools that track this are priced for a development department. This
epic makes the grant — and every dated obligation it creates — the unit of
record: each grant carries its award letter in R2, its report and deliverable
deadlines with a named person responsible, a reminder ladder that escalates to
the grant lead before a deadline is missed, and a portfolio view for the
freelance grant writer who serves several nonprofits at once. The one design
idea: an obligation is a dated row with an assignee and a state (`open`,
`submitted`, `waived`), so "on time" is a database fact (`submitted_at <=
due_on`) rather than a memory, and every reminder is derived from that row.**

Grantwell is for nonprofits under $2M with one to ten staff, fiscal sponsors,
and freelance grant writers. An ED records a grant (funder, amount, period,
restrictions), uploads the award letter, and lists what the award obliges:
reports and deliverables, each with a due date and the person responsible. The
right person hears about each deadline before it arrives, the grant lead hears
about it when it is close or late, and the grant writer sees every client
organization's next deadline on one page.

## Status

| Field | Value |
|-------|-------|
| Status | Draft |
| Cluster | **GW** (GW0–GW3) |
| Owner(s) | `apps/grant-worker` (grants, deadlines, award letters, the reminder cron, the portfolio) · `apps/api-edge` (the facade) · `packages/db` (migrations `200`–`220`) · `packages/contracts` + `packages/sdk` (the wire) · `infra/terraform/cloudflare-r2` (the award-letter bucket) · `apps/notifications-worker` (the templates) · `apps/web-console-next` (the surface) |
| Builds on | `cirrus baseline-v12` — organizations as nonprofits, members as staff and grant writers, the policy engine for who may edit, `notifications-worker` for email, the audit trail in `events-worker`, api-edge rate limiting |
| Changes | Adds one bounded context (`grant`), one worker, one R2 bucket per environment and one cron trigger; turns the Solo profile off (several staff per nonprofit, several nonprofits per writer); every baseline context is reused, none is modified beyond new actions, templates and subject prefixes |
| Decisions locked | (1) A nonprofit is a cirrus organization; its staff and its freelance grant writer are members — the writer's multi-org view is the baseline's multi-membership, not a second tenancy axis. (2) Every obligation is a dated `grant_deadlines` row with an assignee email and a state; "on time" is `submitted_at <= due_on`, computed, never typed. (3) The award letter is stored immutably in R2 and is the source document; nothing is extracted from it automatically until a model credential exists (GW-B). (4) Reminders are derived from deadline rows by a daily cron, each rung claimed with `INSERT … RETURNING` before it is sent, so a rung is sent once even across overlapping ticks. (5) Money is integer cents with an ISO currency; no floating point anywhere. |
| Gate | GW1 is the first user-visible change (grants, deadlines, award letters). GW2 is what makes a missed report hard to miss. GW3 is the grant writer's plan. |
| Shipped as | |

## Read order

1. `design.md` — the resource, the routes, the surfaces, what is out of scope
2. `implementation-plan.md` — the milestones and what "done" means for each
3. `risks-and-open-questions.md` — what could go wrong and what was decided
4. `IMPLEMENTATION-STATUS.md` — what actually shipped (kept distinct from intent)

## Milestones at a glance

| Milestone | What it lands | Done when |
|---|---|---|
| GW0 — the spec | this doc set | merged and pushed with `orun spec push` |
| GW1 — grants, deadlines and award letters | `grant` context (migration `200_grant_core`), R2 bucket per env, `grant-worker`, grant CRUD, report/deliverable deadlines with assignees, award-letter upload and download, the org-wide upcoming-deadlines list, the assignment email, the console grants pages | on stage a signed-in user creates an org (201), a grant, two deadlines and uploads an award letter that downloads byte-for-byte; a deadline marked submitted records whether it was on time; a non-member gets 404 |
| GW2 — the obligations calendar and escalating reminders | `grant_reminders` (migration `210_grant_reminders`), a daily cron with a 30/14/7/1/0-day ladder to the assignee that adds the grant lead from 1 day out and on every overdue rung, the console calendar, the on-time report rate | each rung is sent once and only once across two cron ticks; a submitted deadline sends nothing further; an overdue deadline escalates to the grant lead; the calendar renders every open deadline by month |
| GW3 — the grant writer's portfolio | `GET /v1/me/grant-portfolio` across every organization the caller belongs to, per-org next deadline, overdue count and on-time rate, the console portfolio page, a per-writer weekly digest email | a user who is a member of three orgs sees all three orgs' open deadlines in one response and no other org's; the weekly digest lists them once |

Later, deliberately not built here: award-letter AI extraction and narrative
drafting (no model credential — GW-B), the restricted-funds tracker and report
builder (the brief's M3), funder CRM-lite, PDF report export, and paid plans
(the brief's M4 billing). See `risks-and-open-questions.md`.
