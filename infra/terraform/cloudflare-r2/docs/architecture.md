# cloudflare-r2 — architecture

`terraform apply` (on push to main, per environment) → `cloudflare_r2_bucket.award_letters`
→ bucket `grantwell-award-letters-<env>` → bound by `grant-worker` as `GRANT_DOCS`.
`grant-worker` declares `dependsOn: cloudflare-r2`, so a run that changes both
applies the bucket before it deploys the binding.
