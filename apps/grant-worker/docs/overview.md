# grant-worker — overview

Owns the `grant` bounded context: a nonprofit's **grants** (funder, amount in
integer cents, period, restrictions, grant lead), the dated **deadlines** each
award creates (narrative and financial reports, deliverables, the renewal) with
the person responsible, and the **documents** — the award letter first —
stored in the private R2 bucket `GRANT_DOCS`.

The invariant this worker holds: "on time" is a database fact. A deadline's
`submitted_at` is set exactly while it is `submitted`, and on time means its
date is on or before `due_on`; nothing stores the verdict, so nothing can drift.

## What it serves

| Route | Who |
|---|---|
| `GET/POST /v1/organizations/{org}/grants` | `grant.read` / `grant.write` |
| `GET/PATCH /v1/organizations/{org}/grants/{grt}` | `grant.read` / `grant.write` |
| `POST /v1/organizations/{org}/grants/{grt}/deadlines`, `PATCH …/{gdl}` | `grant.write` |
| `GET /v1/organizations/{org}/deadlines` | `grant.read` |
| `POST /v1/organizations/{org}/grants/{grt}/documents`, `GET …/{gdc}` | `grant.write` / `grant.read` |
