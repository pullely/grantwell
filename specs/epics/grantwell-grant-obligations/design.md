# grantwell-grant-obligations — design

One new bounded context, `grant`, owned by one new worker, `apps/grant-worker`,
behind the baseline's api-edge. Everything else is the cirrus baseline reused:
an organization is a nonprofit, its members are its staff (and, from GW3, the
freelance grant writer it invites), the policy engine decides who may edit, the
notifications worker sends email, the events worker holds the audit trail.

## 1. The resource

Ids are UUIDs in D1 and prefixed public ids on the wire (`grt_`, `gdl_`, `gdc_`
followed by the UUID's 32 hex digits), exactly like the baseline's `org_` and
`prj_`. Every row carries `org_id` and every query scopes by it. Timestamps are
ISO-8601 `TEXT`; dates (`due_on`, `period_start`) are `YYYY-MM-DD` `TEXT`, so a
string comparison is a date comparison.

### 1.1 `grant_grants` (GW1) — `grt_`

```
grant_grants
  id                   text  pk
  org_id               text  the nonprofit
  title                text  "2027 After-School Literacy"
  funder_name          text  "Hollis Family Foundation"
  funder_contact_name  text  null — the program officer
  funder_contact_email text  null
  amount_cents         int   null, >= 0 — integer cents, never a float
  currency             text  'USD' by default, ISO 4217
  period_start         text  null, YYYY-MM-DD
  period_end           text  null, YYYY-MM-DD, >= period_start
  status               text  'active' | 'closed' | 'declined'
  restrictions         text  '' — the award's restrictions, as written
  lead_email           text  null — the grant lead: escalations go here (GW2)
  notes                text  ''
  created_by           text  null — the member's UUID
  created_at, updated_at
```

### 1.2 `grant_deadlines` (GW1) — `gdl_`

An obligation the award creates. Reports and deliverables are the same shape;
`kind` says which.

```
grant_deadlines
  id              text  pk
  org_id          text
  grant_id        text  → grant_grants (cascade)
  kind            text  'narrative_report' | 'financial_report' | 'deliverable' | 'renewal' | 'other'
  title           text  "Interim narrative report"
  due_on          text  YYYY-MM-DD
  assignee_email  text  null — the person responsible; reminders go here
  status          text  'open' | 'submitted' | 'waived'
  submitted_at    text  null — set when status becomes 'submitted', cleared on reopen
  notes           text  ''
  created_by      text  null
  created_at, updated_at
```

`onTime` is derived on the wire: `submitted_at[0:10] <= due_on` for a submitted
deadline, `null` otherwise. It is never stored, so it cannot drift.

### 1.3 `grant_documents` (GW1) — `gdc_`

```
grant_documents
  id            text  pk
  org_id        text
  grant_id      text  → grant_grants (cascade)
  kind          text  'award_letter' | 'report' | 'other'
  object_key    text  orgs/{org_id}/grants/{grant_id}/{document_id} in GRANT_DOCS
  filename      text  sanitized
  content_type  text  application/pdf | image/png | image/jpeg | application/vnd.openxmlformats-officedocument.wordprocessingml.document
  byte_size     int   <= 20 MB
  sha256        text  hex, computed by the worker, returned as x-content-sha256 on download
  uploaded_by   text  null
  uploaded_at   text
```

Documents are immutable: a corrected award letter is a second document.

### 1.4 `grant_reminders` (GW2)

```
grant_reminders
  id           text pk
  org_id       text
  deadline_id  text → grant_deadlines (cascade)
  rung         text  'd30' | 'd14' | 'd7' | 'd1' | 'd0' | 'late1' | 'late7'
  due_on       text  the deadline's due_on when the rung was claimed
  recipients   text  comma list actually sent to
  sent_at      text
  UNIQUE (deadline_id, rung, due_on)
```

The unique key is the idempotency: the cron claims a rung with
`INSERT … ON CONFLICT DO NOTHING RETURNING id` and sends only when a row came
back (runbook trap 22: never trust `rowCount` after a bare write on D1). Moving
a deadline's `due_on` re-arms the ladder because the key includes it.

### 1.5 The award-letter bucket

One private R2 bucket per environment, `grantwell-award-letters-{stage,prod}`,
created by a terraform component `infra/terraform/cloudflare-r2` under a
brokered `CLOUDFLARE_R2_TOKEN` (scope template `r2-data`), bound to
`grant-worker` as `GRANT_DOCS` by bucket name. The worker is the only reader and
writer; there is no public bucket URL.

## 2. The API

Envelopes are the baseline's: `{ data, meta: { requestId, cursor } }` and
`{ error: { code, message, details, requestId } }`. Every route is under the
org lane and authenticated at api-edge (`resolveActor`), which forwards the
actor as headers over the service binding. Authorization is the baseline pair —
membership authorization-context, then policy authorize — and a denial is
**404, never 403**, so a non-member cannot probe for a grant.

| Action | owner | admin | builder | viewer |
|---|---|---|---|---|
| `grant.read` | ✓ | ✓ | ✓ | ✓ |
| `grant.write` | ✓ | ✓ | ✓ | |

### 2.1 Grants (GW1)

```
GET    /v1/organizations/{org}/grants?status=active|closed|declined
         → { grants: PublicGrant[] }        each with nextDeadline (the earliest open one) or null
POST   /v1/organizations/{org}/grants       → 201 { grant }
GET    /v1/organizations/{org}/grants/{grt} → { grant, deadlines: PublicDeadline[], documents: PublicGrantDocument[] }
PATCH  /v1/organizations/{org}/grants/{grt} → { grant }
```

Validation (422 `validation_failed` with `details.fields`): `title` and
`funderName` required (≤ 200); `amountCents` a non-negative integer ≤ 10^12;
`currency` three capitals; `periodStart`/`periodEnd` real dates, end not
before start; emails well-formed; `status` in the set.

### 2.2 Deadlines (GW1)

```
POST   /v1/organizations/{org}/grants/{grt}/deadlines          → 201 { deadline }
PATCH  /v1/organizations/{org}/grants/{grt}/deadlines/{gdl}    → { deadline }
GET    /v1/organizations/{org}/deadlines?status=open&through=YYYY-MM-DD&limit=
         → { deadlines: (PublicDeadline & { grantTitle, funderName })[] }   due_on ascending
```

`PATCH` with `status: "submitted"` stamps `submitted_at`; `status: "open"`
clears it; a deadline on a `declined` grant cannot be created (409). Creating a
deadline with an `assigneeEmail`, or changing it, emails the assignee once
(`grant.deadline.assigned`, idempotency key = deadline + assignee).

### 2.3 Documents (GW1)

```
POST   /v1/organizations/{org}/grants/{grt}/documents?kind=award_letter
         body: the file bytes; content-type one of the four; x-filename: the name
         → 201 { document }         415 for another type, 413 over 20 MB, 422 when empty
GET    /v1/organizations/{org}/grants/{grt}/documents/{gdc}
         → the bytes, content-type as stored, x-content-sha256, content-disposition inline
```

### 2.4 Reminders and the calendar (GW2)

`scheduled()` on `grant-worker`, daily at `0 13 * * *` UTC (morning in every US
time zone). For each open deadline whose next rung is due, claim then send.
`GET /v1/organizations/{org}/deadlines/calendar?month=YYYY-MM` and
`GET /v1/organizations/{org}/grants/stats` (on-time rate over submitted
deadlines, overdue count).

### 2.5 The portfolio (GW3)

`GET /v1/me/grant-portfolio` — the organizations the caller is a member of
(from membership-worker), and for each: name, next open deadline, overdue
count, on-time rate. Orgs the caller is not in never appear; the query is one
`org_id IN (…)` over the caller's memberships, never a scan.

## 3. The console

- **Grants** (`/orgs/{org}/grants`, GW1): the org's grants with funder, amount,
  period and next deadline; a "New grant" form; below it, the org's upcoming
  open deadlines across all grants, overdue ones first.
- **Grant** (`/orgs/{org}/grants/{grt}`, GW1): the grant's facts and
  restrictions; its deadlines with assignee, due date and state, an "add
  deadline" form and a "mark submitted" action that shows on-time or late; its
  documents with an award-letter upload and a download link.
- **Calendar** (`/orgs/{org}/grants/calendar`, GW2): a month grid of deadlines.
- **Portfolio** (`/portfolio`, GW3): the grant writer's cross-org table.

The nav gains "Grants" for every org. The Solo profile is turned off
(`SOLO_MODE=false` on api-edge, identity-worker, membership-worker and the
console): several staff share a nonprofit and a writer serves several.

## 4. Events, secrets, and integrations

Audit events (domain event + audit row, category `grant`): `grant.created`,
`grant.updated`, `grant.deadline.created`, `grant.deadline.updated`,
`grant.deadline.submitted`, `grant.document.uploaded` (GW1);
`grant.reminder.sent` (GW2). Subject kinds `grant` and `grant_deadline` get the
`grt_`/`gdl_` prefixes in events-worker's public-id table.

Email templates (notifications-worker): `grant.deadline.assigned` (GW1),
`grant.deadline.reminder` (GW2), `grant.portfolio.digest` (GW3).
`grant-worker` is added to `NOTIFICATIONS_INTERNAL_ACTOR_VALUES`, without which
notifications-worker refuses its calls with 403.

Secrets: `CLOUDFLARE_R2_TOKEN` per environment (brokered, `r2-data`), used only
by the R2 terraform component. No other provider connection is needed.

## 5. Out of scope

- **Award-letter extraction and narrative drafting** — the brief's LLM features
  need a model credential this workspace does not hold (GW-B). The award letter
  is stored now so extraction can run over it later without a re-upload.
- **Restricted-funds tracking and the report builder** — the brief's M3: budget
  lines, expenses and a narrative pre-fill. A later epic.
- **Funder CRM-lite** — contacts and renewal likelihood beyond the program
  officer fields on the grant.
- **PDF report export**, **paid plans** (the $29 / $59 tiers are Polar config on
  the baseline's billing context once priced), **the `grantwell.app` custom
  domain** (the zone is not on this account).
