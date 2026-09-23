# grantwell-grant-obligations (GW) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| GW0 — the spec | ✅ landed | #9 |
| GW1 — grants, deadlines and award letters | in review | GW-2 |
| GW2 — the obligations calendar and escalating reminders | | |
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
