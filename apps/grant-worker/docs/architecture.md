# grant-worker — architecture

```
staff / grant writer ──► api-edge ──(resolveActor)──► grant-worker ──► D1 (grant_*)
                                                                    ├─► membership-worker (context)
                                                                    ├─► policy-worker (authorize)
                                                                    ├─► R2 GRANT_DOCS (award letters)
                                                                    └─► notifications-worker (email)
```

- Reachable only over the `GRANT_WORKER` service binding (`workers_dev: false`).
- Every route runs membership authorization-context then policy authorize; a
  deny is `404`, never `403`.
- Documents are read whole (≤ 20 MB), hashed, and put under
  `orgs/{org}/grants/{grant}/{document}` — a key no second upload can reuse.
- D1 has no interactive transactions: every write whose outcome matters uses
  `RETURNING` (the D1 executor's `rowCount` is 0 for a bare write), and audit
  appends are best-effort after the write they describe.
- Depends on `db-migrate`, so a run that adds a migration applies it before this
  worker's code that reads the new columns goes live.
