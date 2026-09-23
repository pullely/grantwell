import type {
  CreateGrantDeadlineRequest,
  CreateGrantRequest,
  GetGrantResponse,
  GrantDeadlineResponse,
  GrantDocumentKind,
  GrantDocumentResponse,
  GrantResponse,
  ListGrantDeadlinesResponse,
  ListGrantsResponse,
  UpdateGrantDeadlineRequest,
  UpdateGrantRequest,
} from "@saas/contracts/grant";

import { decodeError } from "./errors.js";
import { generateRequestId, type RequestOptions, type Transport } from "./transport.js";

const org = (orgId: string): string => `/v1/organizations/${encodeURIComponent(orgId)}`;
const grant = (orgId: string, grantId: string): string => `${org(orgId)}/grants/${encodeURIComponent(grantId)}`;

/**
 * Grants client — a nonprofit's grants, the deadlines each award creates and
 * the award letters stored against them. Org-scoped; maps to
 * `apps/grant-worker` through the api-edge grant facade.
 */
export class GrantClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/grants */
  listGrants(orgId: string, query: { status?: string } = {}, opts: RequestOptions = {}): Promise<ListGrantsResponse> {
    return this.transport.request<ListGrantsResponse>(
      { method: "GET", path: `${org(orgId)}/grants`, query: { status: query.status } },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/grants */
  createGrant(orgId: string, body: CreateGrantRequest, opts: RequestOptions = {}): Promise<GrantResponse> {
    return this.transport.request<GrantResponse>({ method: "POST", path: `${org(orgId)}/grants`, body }, opts);
  }

  /** GET /v1/organizations/:orgId/grants/:grantId — the grant with its deadlines and documents. */
  getGrant(orgId: string, grantId: string, opts: RequestOptions = {}): Promise<GetGrantResponse> {
    return this.transport.request<GetGrantResponse>({ method: "GET", path: grant(orgId, grantId) }, opts);
  }

  /** PATCH /v1/organizations/:orgId/grants/:grantId */
  updateGrant(orgId: string, grantId: string, body: UpdateGrantRequest, opts: RequestOptions = {}): Promise<GrantResponse> {
    return this.transport.request<GrantResponse>({ method: "PATCH", path: grant(orgId, grantId), body }, opts);
  }

  /** POST /v1/organizations/:orgId/grants/:grantId/deadlines */
  createDeadline(
    orgId: string,
    grantId: string,
    body: CreateGrantDeadlineRequest,
    opts: RequestOptions = {},
  ): Promise<GrantDeadlineResponse> {
    return this.transport.request<GrantDeadlineResponse>(
      { method: "POST", path: `${grant(orgId, grantId)}/deadlines`, body },
      opts,
    );
  }

  /** PATCH /v1/organizations/:orgId/grants/:grantId/deadlines/:deadlineId */
  updateDeadline(
    orgId: string,
    grantId: string,
    deadlineId: string,
    body: UpdateGrantDeadlineRequest,
    opts: RequestOptions = {},
  ): Promise<GrantDeadlineResponse> {
    return this.transport.request<GrantDeadlineResponse>(
      { method: "PATCH", path: `${grant(orgId, grantId)}/deadlines/${encodeURIComponent(deadlineId)}`, body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/deadlines — every grant's deadlines, due date ascending. */
  listDeadlines(
    orgId: string,
    query: { status?: string; through?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ): Promise<ListGrantDeadlinesResponse> {
    return this.transport.request<ListGrantDeadlinesResponse>(
      { method: "GET", path: `${org(orgId)}/deadlines`, query },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/grants/:grantId/documents — the body is the
   * file itself (PDF, Word, PNG or JPEG, up to 20 MB), not JSON.
   */
  async uploadDocument(
    orgId: string,
    grantId: string,
    file: Blob | ArrayBuffer | Uint8Array,
    meta: { contentType: string; filename: string; kind?: GrantDocumentKind },
    opts: RequestOptions = {},
  ): Promise<GrantDocumentResponse> {
    const t = this.transport;
    const requestId = opts.requestId ?? generateRequestId();
    const url = new URL(`${t.baseUrl}${grant(orgId, grantId)}/documents`);
    url.searchParams.set("kind", meta.kind ?? "award_letter");
    const headers = new Headers();
    for (const [k, v] of Object.entries(t.defaultHeaders)) headers.set(k, v);
    if (t.auth?.kind === "bearer") headers.set("authorization", `Bearer ${t.auth.token}`);
    if (t.auth?.kind === "session") headers.set("cookie", t.auth.cookie);
    headers.set("content-type", meta.contentType);
    headers.set("x-filename", meta.filename);
    headers.set("accept", "application/json");
    headers.set("x-request-id", requestId);
    if (opts.idempotencyKey !== undefined) headers.set("idempotency-key", opts.idempotencyKey);
    const init: RequestInit = { method: "POST", headers, body: file as BodyInit };
    if (opts.signal !== undefined) init.signal = opts.signal;
    const response = await t.fetchImpl(url.toString(), init);
    if (!response.ok) throw await decodeError(response, requestId);
    const parsed = (await response.json()) as { data: GrantDocumentResponse };
    return parsed.data;
  }

  /** The URL a document downloads from (the caller supplies its own credentials). */
  documentUrl(orgId: string, grantId: string, documentId: string): string {
    return `${this.transport.baseUrl}${grant(orgId, grantId)}/documents/${encodeURIComponent(documentId)}`;
  }
}
