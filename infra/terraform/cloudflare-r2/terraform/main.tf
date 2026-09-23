terraform {
  required_version = ">= 1.15.0"

  # State lives on the platform (SB1): the runner exports TF_HTTP_* per job, so
  # this block stays empty — no S3 bucket, no AWS role, no workspaces.
  backend "http" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.30"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}

# --- Providers ---

# Authenticates via the CLOUDFLARE_API_TOKEN env var (provider-native): the
# token is an orun-managed secret resolved into the job env at run time, so it
# never transits Terraform variables.
provider "cloudflare" {}

# --- Variables (standard Orun parameters) ---

variable "cloudflare_account_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare account ID (from CLOUDFLARE_ACCOUNT_ID env var)"
}

variable "orgName" {
  type    = string
  default = "sourceplane"
}

variable "owner" {
  type    = string
  default = "sourceplane"
}

variable "repo" {
  type    = string
  default = "grantwell"
}

variable "namespace" {
  type    = string
  default = "sourceplane"
}

variable "namespacePrefix" {
  type    = string
  default = ""
}

variable "lane" {
  type    = string
  default = "verify"
}

variable "environment" {
  type    = string
  default = "stage"
}

variable "component" {
  type    = string
  default = "cloudflare-r2"
}

variable "stackName" {
  type    = string
  default = "cloudflare-r2"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# --- R2 bucket for award letters (GW1) ---
#
# One private bucket per environment. It holds every award letter and grant
# document a nonprofit uploads. Objects are keyed
# orgs/{org_id}/grants/{grant_id}/{document_id} and are never overwritten.
# Nothing is public: every read goes through grant-worker, authorized by
# membership.
#
# The name is deterministic — grant-worker's wrangler template binds it by name —
# so it deliberately does not take var.namespacePrefix or var.repo: a prefix
# supplied at run time would silently diverge from the binding.

locals {
  award_letters_bucket_name = "grantwell-award-letters-${var.environment}"
}

resource "cloudflare_r2_bucket" "award_letters" {
  account_id = var.cloudflare_account_id
  name       = local.award_letters_bucket_name
}

# --- Wiring manifest (BF5, via orun secrets) ---
# An R2 binding resolves by bucket NAME, not by an opaque id; the document is
# published for parity with D1 and KV so any later consumer can read it back.

output "wiring" {
  description = "Wiring document for downstream deploy-time binding resolution (pushed to orun secrets)"
  value = jsonencode({
    award_letters_bucket_name = cloudflare_r2_bucket.award_letters.name
  })
}

output "award_letters_bucket_name" {
  description = "Cloudflare R2 bucket holding award letters and grant documents"
  value       = cloudflare_r2_bucket.award_letters.name
}
