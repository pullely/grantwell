import type { Env } from "./env.js";
import type { GrantRepository } from "@saas/db/grant";
import type { SqlExecutor } from "@saas/db/d1";
import { createGrantRepository } from "@saas/db/grant";
import { createSqlExecutor } from "@saas/db/d1";

export interface Db {
  executor: SqlExecutor;
  grants: GrantRepository;
}

/** Open the request's database handle, or null when the binding is missing. */
export function openDb(env: Env): (Db & { dispose(): Promise<void> }) | null {
  if (!env.PLATFORM_DB) return null;
  const executor = createSqlExecutor(env.PLATFORM_DB);
  return { executor, grants: createGrantRepository(executor), dispose: () => executor.dispose() };
}

export function nowIso(): string {
  return new Date().toISOString();
}
