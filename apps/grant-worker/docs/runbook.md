# grant-worker — runbook

- **Health:** `GET /health` on the worker (via a service binding) reports which
  bindings are configured: database, documents (R2), membership, policy,
  notifications.
- **Every route answers 404 for a member:** policy-worker is running an old
  action table without `grant.read`/`grant.write`. A change to
  `packages/policy-engine` does not redeploy policy-worker by itself: touch its
  `component.yaml` and merge.
- **Uploads answer 503:** the `GRANT_DOCS` binding is missing — the
  `cloudflare-r2` component has not applied in that environment, or the
  brokered `CLOUDFLARE_R2_TOKEN` is missing. Re-run the R2 component's apply.
- **The assignee got no email:** notifications are advisory. Check that
  `grant-worker` is in `NOTIFICATIONS_INTERNAL_ACTOR_VALUES` and that
  notifications-worker was redeployed after it was added; otherwise the call is
  refused with 403.
