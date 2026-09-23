# grantwell-grant-obligations — risks and open questions

Each entry is a letter, a title, and a state: **RISK** (open, with a
mitigation), **RESOLVED** (decided; say what and why), **ACCEPTED** (a cost we
carry knowingly), **SETTLED** (decided for now; revisit on a stated cadence).

## GW-A — The baseline's audited writes do not run on D1 (RESOLVED)

The cirrus baseline's `appendEventWithAudit` and membership repository use
Postgres-only SQL (a data-modifying CTE, `row_to_json`, `FULL JOIN`) that SQLite
cannot parse, so on D1 organization create fails and every audited write is
lost. A tested patch (`cirrus-d1-fix.patch`, landed first in chaseid) fixes the
events/audit and membership paths; GW1 applies it and touches every worker's
`component.yaml` so the fix actually deploys. `grant-worker` additionally writes
its own audit rows with two portable statements, so its audit trail does not
depend on the patched path. The `updated_at = now()` sites in the config and
webhooks repositories are not in the patch; Grantwell does not write through
them.

## GW-B — Award-letter extraction needs a model credential (RISK, open)

The brief's first MVP bullet — upload an award letter and have AI extract the
amount, period, deliverables, report dates and restrictions — needs an LLM
(Claude or Workers AI) credential that nobody has provided to this workspace.
Mitigation: GW1 stores every award letter in R2 with its SHA-256, and the grant
and deadline records it would populate are the ones a person types today, so
extraction becomes a "suggest a draft grant from this letter" step over data
already stored — no migration of documents, no change to the record. The same
credential gates the report builder's narrative pre-fill. Both wait for an
owner decision on the credential.

## GW-C — Email is advisory; the record is D1 (ACCEPTED)

Assignment and reminder emails go through the baseline's best-effort
notifications path, which never fails the caller. A bounced reminder does not
un-send it and does not stop the ladder. The console's upcoming-deadlines list
is the source of truth, and GW2's escalation to the grant lead is the backstop
for an assignee who never reads mail.

## GW-D — The D1 executor's `rowCount` after a write (RESOLVED)

The baseline's D1 executor reports `rowCount = rows.length`, so an `UPDATE`,
`INSERT` or `DELETE` without `RETURNING` always reports 0 on D1. Every grant
repository write whose outcome is inspected uses `RETURNING`, and
`tests/grant-worker` pins this over the real executor and a real SQLite engine
(a mocked executor would hide it).

## GW-E — Time zones and "due today" (SETTLED)

`due_on` is a calendar date with no zone. GW2's daily cron runs at 13:00 UTC,
which is morning in every US time zone, and compares against the UTC date. A
nonprofit in Hawaii may see the 0-day reminder a day early by local clock. We
accept this for the US-first launch; revisit if a design partner outside the
Americas signs up.

## GW-F — Mint budget for CI (ACCEPTED)

Each workspace can mint 200 brokered credentials per rolling day and every
deploying CI job spends one, so a bootstrap plus three milestones does not fit
in a day. GW1 lands on day one, GW2 and GW3 on day two, and every milestone is
tested locally before its pull request opens.

## GW-G — Multi-org grant writers and plan limits (RISK, open)

The brief prices a Grant Writer plan at "up to 10 orgs". GW3 builds the
portfolio on the baseline's memberships and does not enforce a cap; the cap
belongs to billing, which needs Polar products priced by the owner. Until then
a writer can join any number of client organizations.

## GW-H — The custom domain (ACCEPTED)

`grantwell.app` is not a zone on this Cloudflare account, so the product lives
on `*.nexo-7be.workers.dev`. Moving it is the baseline's phase 07 once the zone
exists; nothing in the epic depends on the hostname.
