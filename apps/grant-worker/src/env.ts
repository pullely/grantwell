export interface Env {
  PLATFORM_DB?: D1Database;
  /** Private R2 bucket holding every award letter and grant document. */
  GRANT_DOCS?: R2Bucket;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
}
