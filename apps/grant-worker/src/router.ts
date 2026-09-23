import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleCreateGrant, handleGetGrant, handleListGrants, handleUpdateGrant } from "./handlers/grants.js";
import { handleCreateDeadline, handleListDeadlines, handleUpdateDeadline } from "./handlers/deadlines.js";
import { handleGetDocument, handleUploadDocument } from "./handlers/documents.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import {
  generateRequestId,
  parseDeadlinePublicId,
  parseDocumentPublicId,
  parseGrantPublicId,
  parseOrgPublicId,
} from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  return header && REQUEST_ID_RE.test(header) ? header : generateRequestId();
}

/**
 * This worker is unreachable except over a service binding from api-edge, so
 * the actor arrives as headers the edge resolved and set — never as a token.
 */
function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

// Every route is org-scoped: /v1/organizations/{org}/…
const GRANTS_RE = /^\/v1\/organizations\/([^/]+)\/grants$/;
const GRANT_RE = /^\/v1\/organizations\/([^/]+)\/grants\/([^/]+)$/;
const GRANT_DEADLINES_RE = /^\/v1\/organizations\/([^/]+)\/grants\/([^/]+)\/deadlines$/;
const GRANT_DEADLINE_RE = /^\/v1\/organizations\/([^/]+)\/grants\/([^/]+)\/deadlines\/([^/]+)$/;
const GRANT_DOCUMENTS_RE = /^\/v1\/organizations\/([^/]+)\/grants\/([^/]+)\/documents$/;
const GRANT_DOCUMENT_RE = /^\/v1\/organizations\/([^/]+)\/grants\/([^/]+)\/documents\/([^/]+)$/;
const ORG_DEADLINES_RE = /^\/v1\/organizations\/([^/]+)\/deadlines$/;

function unauthenticated(requestId: string): Response {
  return errorResponse("unauthenticated", "Authentication required", 401, requestId);
}

async function routeOrg(request: Request, env: Env, requestId: string, path: string): Promise<Response | null> {
  let m: RegExpMatchArray | null;
  const method = request.method;

  if ((m = path.match(GRANT_DOCUMENT_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const grant = parseGrantPublicId(m[2]!);
    const doc = parseDocumentPublicId(m[3]!);
    if (!org || !grant || !doc) return notFound(requestId);
    if (method !== "GET") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return handleGetDocument(env, requestId, actor, org, grant, doc);
  }
  if ((m = path.match(GRANT_DOCUMENTS_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const grant = parseGrantPublicId(m[2]!);
    if (!org || !grant) return notFound(requestId);
    if (method !== "POST") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return handleUploadDocument(request, env, requestId, actor, org, grant);
  }
  if ((m = path.match(GRANT_DEADLINE_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const grant = parseGrantPublicId(m[2]!);
    const deadline = parseDeadlinePublicId(m[3]!);
    if (!org || !grant || !deadline) return notFound(requestId);
    if (method !== "PATCH") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return handleUpdateDeadline(request, env, requestId, actor, org, grant, deadline);
  }
  if ((m = path.match(GRANT_DEADLINES_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const grant = parseGrantPublicId(m[2]!);
    if (!org || !grant) return notFound(requestId);
    if (method !== "POST") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return handleCreateDeadline(request, env, requestId, actor, org, grant);
  }
  if ((m = path.match(GRANT_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const grant = parseGrantPublicId(m[2]!);
    if (!org || !grant) return notFound(requestId);
    if (method !== "GET" && method !== "PATCH") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return method === "GET"
      ? handleGetGrant(env, requestId, actor, org, grant)
      : handleUpdateGrant(request, env, requestId, actor, org, grant);
  }
  if ((m = path.match(GRANTS_RE))) {
    const org = parseOrgPublicId(m[1]!);
    if (!org) return notFound(requestId);
    if (method !== "GET" && method !== "POST") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return method === "GET"
      ? handleListGrants(request, env, requestId, actor, org)
      : handleCreateGrant(request, env, requestId, actor, org);
  }
  if ((m = path.match(ORG_DEADLINES_RE))) {
    const org = parseOrgPublicId(m[1]!);
    if (!org) return notFound(requestId);
    if (method !== "GET") return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return unauthenticated(requestId);
    return handleListDeadlines(request, env, requestId, actor, org);
  }
  return null;
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") return handleHealth(env, requestId);
    const response = await routeOrg(request, env, requestId, url.pathname);
    return response ?? notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
