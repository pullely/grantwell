import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

// Grants (grant-worker). One authenticated lane, /v1/organizations/{org}/…:
// grants, their deadlines and documents, and the org-wide deadline list.
// resolveActor → actor headers over the GRANT_WORKER binding, like every other
// org route; the worker runs membership + policy itself.

const GRANT_RE =
  /^\/v1\/organizations\/[^/]+\/(?:grants(?:\/[^/]+(?:\/(?:deadlines|documents)(?:\/[^/]+)?)?)?|deadlines)$/;

const FORWARDED_HEADERS = ["content-type", "content-length", "traceparent", "idempotency-key", "x-filename"];
const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

export function isGrantRoute(pathname: string): boolean {
  return GRANT_RE.test(pathname);
}

export async function handleGrantRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  return replayOrExecute(request, requestId, env, "grant", async () => {
    if (!env.GRANT_WORKER) {
      return errorResponse("internal_error", "Grants service unavailable", 503, requestId);
    }
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const session = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in session) return session.error;

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", session.subjectId);
    headers.set("x-actor-subject-type", session.subjectType);
    headers.set("x-actor-email", session.email);
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://grant.internal");
    const init: RequestInit = { method: request.method, headers };
    if (BODY_METHODS.has(request.method)) init.body = request.body;

    try {
      const downstream = await timings.measure("edge_downstream", () =>
        env.GRANT_WORKER!.fetch(target.toString(), init),
      );
      const res = new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.grant", timings);
    } catch {
      return errorResponse("internal_error", "Grants service unavailable", 503, requestId);
    }
  });
}
