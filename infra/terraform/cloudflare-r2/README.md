# cloudflare-r2

Provisions one private Cloudflare R2 bucket per environment,
`grantwell-award-letters-stage` and `grantwell-award-letters-prod`, holding
every award letter and grant document a nonprofit uploads.

- **Consumed by:** `apps/grant-worker`, bound as `GRANT_DOCS` by bucket name.
- **Credential:** a brokered `CLOUDFLARE_R2_TOKEN` (scope template `r2-data`),
  not the deploy token.
- **Adoption:** `terraform/adopt.tf` imports a bucket Cloudflare already has but
  state does not track, so a lost state write cannot wedge the apply.
- `dev` is verify-only and provisions nothing.
