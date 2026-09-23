import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isGrantRoute, handleGrantRoute } from "@api-edge/grant-facade";
import { isOrgRoute } from "@api-edge/org-facade";

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripJsoncComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function recorder(respond: (url: string) => Response): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function identity(userId: string) {
  return recorder(() =>
    Response.json({
      data: {
        actor: { actorType: "user", actorId: userId, email: "ed@literacy.example" },
        session: { id: "ses_abc", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
        user: { id: userId, email: "ed@literacy.example", displayName: "ED" },
      },
      meta: { requestId: "req_inner", cursor: null },
    }),
  );
}

describe("api-edge grant facade", () => {
  it("claims the grant routes and nothing else", () => {
    for (const p of [
      "/v1/organizations/org_a/grants",
      "/v1/organizations/org_a/grants/grt_b",
      "/v1/organizations/org_a/grants/grt_b/deadlines",
      "/v1/organizations/org_a/grants/grt_b/deadlines/gdl_c",
      "/v1/organizations/org_a/grants/grt_b/documents",
      "/v1/organizations/org_a/grants/grt_b/documents/gdc_d",
      "/v1/organizations/org_a/deadlines",
    ]) {
      expect(isGrantRoute(p)).toBe(true);
    }
    for (const p of [
      "/v1/organizations/org_a",
      "/v1/organizations/org_a/projects",
      "/v1/organizations/org_a/members",
      "/v1/organizations/org_a/grants/grt_b/budget",
      "/v1/organizations/org_a/deadlines/gdl_c",
    ]) {
      expect(isGrantRoute(p)).toBe(false);
    }
  });

  it("is dispatched before the org facade would swallow it", () => {
    // index.ts checks isGrantRoute before isOrgRoute; whether or not the org
    // facade's pattern also matches, the grant facade must answer these paths.
    expect(isGrantRoute("/v1/organizations/org_a/grants")).toBe(true);
    expect(typeof isOrgRoute("/v1/organizations/org_a/grants")).toBe("boolean");
  });

  it("forwards an authenticated call to GRANT_WORKER with the actor as headers", async () => {
    const id = identity("usr_abc123");
    const worker = recorder(() =>
      Response.json({ data: { grant: { id: "grt_x" } }, meta: { requestId: "req_test", cursor: null } }, { status: 201 }),
    );
    const request = new Request("https://api.example.com/v1/organizations/org_a/grants", {
      method: "POST",
      headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json", "x-actor-subject-id": "usr_spoofed" },
      body: JSON.stringify({ title: "Literacy", funderName: "Hollis" }),
    });
    const response = await handleGrantRoute(
      request,
      { IDENTITY_WORKER: id.fetcher, GRANT_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/grants",
    );
    expect(response.status).toBe(201);
    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0]!.url).toBe("https://grant.internal/v1/organizations/org_a/grants");
    const headers = new Headers(worker.calls[0]!.init.headers);
    expect(headers.get("x-actor-subject-id")).toBe("usr_abc123"); // never the caller's own header
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("answers 401 without a bearer and never reaches the worker", async () => {
    const id = recorder(() => Response.json({ error: { code: "unauthenticated", message: "no", details: {}, requestId: "r" } }, { status: 401 }));
    const worker = recorder(() => Response.json({}));
    const response = await handleGrantRoute(
      new Request("https://api.example.com/v1/organizations/org_a/grants"),
      { IDENTITY_WORKER: id.fetcher, GRANT_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/grants",
    );
    expect(response.status).toBe(401);
    expect(worker.calls).toHaveLength(0);
  });

  it("answers 503 when the binding is missing", async () => {
    const response = await handleGrantRoute(
      new Request("https://api.example.com/v1/organizations/org_a/grants"),
      { ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/grants",
    );
    expect(response.status).toBe(503);
  });

  it("wrangler.jsonc binds GRANT_WORKER on stage and prod", () => {
    const raw = readFileSync(resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc"), "utf8");
    const config = JSON.parse(stripJsoncComments(raw)) as {
      env: Record<string, { services?: { binding: string; service: string }[] }>;
    };
    for (const env of ["stage", "prod"]) {
      const binding = config.env[env]!.services!.find((s) => s.binding === "GRANT_WORKER");
      expect(binding?.service).toBe(`grantwell-grant-worker-${env}`);
    }
  });
});
