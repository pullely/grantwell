/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { createHash } from "node:crypto";
import { route } from "@grant-worker/router";
import { orgPublicId } from "@grant-worker/ids";
import { MEMBER, OWNER, STRANGER, VIEWER, as, json, world, type TestWorld } from "./harness";

const ORG_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = orgPublicId(ORG_UUID);
const OTHER_ORG = orgPublicId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const BASE = "https://grant.internal";

function call(w: TestWorld, path: string, init: RequestInit = {}): Promise<Response> {
  return route(new Request(`${BASE}${path}`, init), w.env);
}

function post(w: TestWorld, path: string, who: string, body: unknown, method = "POST"): Promise<Response> {
  return call(w, path, {
    method,
    headers: { ...as(who), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createGrant(w: TestWorld, overrides: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const res = await post(w, `/v1/organizations/${ORG}/grants`, OWNER, {
    title: "2027 After-School Literacy",
    funderName: "Hollis Family Foundation",
    funderContactName: "Mara Quinn",
    funderContactEmail: "mquinn@hollis.example",
    amountCents: 2_500_000,
    periodStart: "2027-01-01",
    periodEnd: "2027-12-31",
    restrictions: "Program staff and books only; no indirect costs.",
    leadEmail: "ed@literacy.example",
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await json(res)).data.grant;
}

function pdf(label: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% ${label}\n1 0 obj << >> endobj\n%%EOF\n`);
}

describe("grants", () => {
  it("creates, reads and patches a grant, auditing each write", async () => {
    const w = world();
    const grant = await createGrant(w);
    expect(grant.id).toMatch(/^grt_[0-9a-f]{32}$/);
    expect(grant.orgId).toBe(ORG);
    expect(grant.amountCents).toBe(2_500_000);
    expect(grant.currency).toBe("USD");
    expect(grant.status).toBe("active");
    expect(grant.nextDeadline).toBeNull();

    const patched = await json(
      await post(w, `/v1/organizations/${ORG}/grants/${grant.id}`, MEMBER, { status: "closed", notes: "Final report accepted" }, "PATCH"),
    );
    expect(patched.data.grant.status).toBe("closed");
    expect(patched.data.grant.title).toBe("2027 After-School Literacy"); // absent fields keep their value
    expect(patched.data.grant.notes).toBe("Final report accepted");

    const list = await json(await call(w, `/v1/organizations/${ORG}/grants?status=closed`, { headers: as(VIEWER) }));
    expect(list.data.grants).toHaveLength(1);

    const audit = w.db
      .prepare("SELECT event_type, category, org_id FROM events_audit_entries ORDER BY occurred_at")
      .all() as { event_type: string; category: string; org_id: string }[];
    expect(audit.map((a) => a.event_type)).toEqual(["grant.created", "grant.updated"]);
    expect(audit.every((a) => a.category === "grant" && a.org_id === ORG_UUID)).toBe(true);
  });

  it("validates money, dates and the period", async () => {
    const w = world();
    const res = await post(w, `/v1/organizations/${ORG}/grants`, OWNER, {
      title: "X",
      funderName: "Y",
      amountCents: 12.5,
      periodStart: "2027-02-30",
      currency: "usd",
    });
    expect(res.status).toBe(422);
    const fields = (await json(res)).error.details.fields;
    expect(Object.keys(fields).sort()).toEqual(["amountCents", "currency", "periodStart"]);

    const backwards = await post(w, `/v1/organizations/${ORG}/grants`, OWNER, {
      title: "X",
      funderName: "Y",
      periodStart: "2027-06-01",
      periodEnd: "2027-01-01",
    });
    expect(backwards.status).toBe(422);
  });

  it("is invisible to a non-member and read-only to a viewer — 404, never 403", async () => {
    const w = world();
    const grant = await createGrant(w);
    expect((await call(w, `/v1/organizations/${ORG}/grants/${grant.id}`, { headers: as(STRANGER) })).status).toBe(404);
    expect((await call(w, `/v1/organizations/${ORG}/grants`, { headers: as(STRANGER) })).status).toBe(404);
    expect((await call(w, `/v1/organizations/${ORG}/grants/${grant.id}`, { headers: as(VIEWER) })).status).toBe(200);
    expect((await post(w, `/v1/organizations/${ORG}/grants`, VIEWER, { title: "A", funderName: "B" })).status).toBe(404);
    expect((await post(w, `/v1/organizations/${ORG}/grants/${grant.id}/deadlines`, VIEWER, {
      kind: "deliverable", title: "T", dueOn: "2027-03-01",
    })).status).toBe(404);
  });

  it("never serves one org's grant under another org's path", async () => {
    const w = world();
    const grant = await createGrant(w);
    expect((await call(w, `/v1/organizations/${OTHER_ORG}/grants/${grant.id}`, { headers: as(OWNER) })).status).toBe(404);
  });

  it("answers 401 without an actor and 404 for a malformed id", async () => {
    const w = world();
    expect((await call(w, `/v1/organizations/${ORG}/grants`)).status).toBe(401);
    expect((await call(w, `/v1/organizations/${ORG}/grants/grt_nothex`, { headers: as(OWNER) })).status).toBe(404);
  });
});

describe("deadlines", () => {
  it("adds deadlines, emails the assignee once, and lists them org-wide by due date", async () => {
    const w = world();
    const grant = await createGrant(w);
    const interim = await post(w, `/v1/organizations/${ORG}/grants/${grant.id}/deadlines`, OWNER, {
      kind: "narrative_report",
      title: "Interim narrative report",
      dueOn: "2027-07-15",
      assigneeEmail: "Program@Literacy.example",
    });
    expect(interim.status).toBe(201);
    const interimBody = (await json(interim)).data;
    expect(interimBody.deadline.id).toMatch(/^gdl_[0-9a-f]{32}$/);
    expect(interimBody.deadline.assigneeEmail).toBe("program@literacy.example");
    expect(interimBody.deadline.status).toBe("open");
    expect(interimBody.deadline.onTime).toBeNull();
    expect(interimBody.assigneeNotified).toBe(true);

    const financial = await post(w, `/v1/organizations/${ORG}/grants/${grant.id}/deadlines`, MEMBER, {
      kind: "financial_report",
      title: "Final financial report",
      dueOn: "2028-01-31",
    });
    expect(financial.status).toBe(201);
    expect((await json(financial)).data.assigneeNotified).toBe(false);

    expect(w.sent).toHaveLength(1);
    const mail = w.sent[0] as Record<string, any>;
    expect(mail.templateKey).toBe("grant.deadline.assigned");
    expect(mail.recipient).toEqual({ channel: "email", address: "program@literacy.example" });
    expect(mail.templateData.dueOn).toBe("2027-07-15");

    const all = await json(await call(w, `/v1/organizations/${ORG}/deadlines`, { headers: as(VIEWER) }));
    expect(all.data.deadlines.map((d: { title: string }) => d.title)).toEqual([
      "Interim narrative report",
      "Final financial report",
    ]);
    expect(all.data.deadlines[0].grantTitle).toBe("2027 After-School Literacy");
    expect(all.data.deadlines[0].funderName).toBe("Hollis Family Foundation");

    const soon = await json(await call(w, `/v1/organizations/${ORG}/deadlines?through=2027-12-31`, { headers: as(OWNER) }));
    expect(soon.data.deadlines).toHaveLength(1);

    const grants = await json(await call(w, `/v1/organizations/${ORG}/grants`, { headers: as(OWNER) }));
    expect(grants.data.grants[0].nextDeadline.title).toBe("Interim narrative report");
  });

  it("records on time vs late from submitted_at and due_on, and clears it on reopen", async () => {
    const w = world();
    const grant = await createGrant(w);
    const future = (await json(await post(w, `/v1/organizations/${ORG}/grants/${grant.id}/deadlines`, OWNER, {
      kind: "deliverable", title: "Curriculum delivered", dueOn: "2999-01-01",
    }))).data.deadline;
    const past = (await json(await post(w, `/v1/organizations/${ORG}/grants/${grant.id}/deadlines`, OWNER, {
      kind: "narrative_report", title: "Year-one report", dueOn: "2020-01-01",
    }))).data.deadline;

    const path = (d: { id: string }) => `/v1/organizations/${ORG}/grants/${grant.id}/deadlines/${d.id}`;
    const onTime = await json(await post(w, path(future), MEMBER, { status: "submitted" }, "PATCH"));
    expect(onTime.data.deadline.status).toBe("submitted");
    expect(onTime.data.deadline.submittedAt).not.toBeNull();
    expect(onTime.data.deadline.onTime).toBe(true);

    const late = await json(await post(w, path(past), MEMBER, { status: "submitted" }, "PATCH"));
    expect(late.data.deadline.onTime).toBe(false);

    const reopened = await json(await post(w, path(past), OWNER, { status: "open" }, "PATCH"));
    expect(reopened.data.deadline.submittedAt).toBeNull();
    expect(reopened.data.deadline.onTime).toBeNull();

    const types = (w.db.prepare("SELECT event_type FROM events_audit_entries ORDER BY occurred_at").all() as { event_type: string }[]).map(
      (r) => r.event_type,
    );
    expect(types.filter((t) => t === "grant.deadline.submitted")).toHaveLength(2);
    expect(types).toContain("grant.deadline.updated");

    const submittedPayload = w.db
      .prepare("SELECT payload FROM events_event_log WHERE type = 'grant.deadline.submitted' ORDER BY occurred_at")
      .all() as { payload: string }[];
    expect(submittedPayload.map((p) => JSON.parse(p.payload).onTime)).toEqual([true, false]);
  });

  it("emails a new assignee on reassignment, and refuses obligations on a declined grant", async () => {
    const w = world();
    const grant = await createGrant(w);
    const d = (await json(await post(w, `/v1/organizations/${ORG}/grants/${grant.id}/deadlines`, OWNER, {
      kind: "renewal", title: "Renewal LOI", dueOn: "2027-10-01", assigneeEmail: "a@literacy.example",
    }))).data.deadline;
    const moved = await json(await post(w, `/v1/organizations/${ORG}/grants/${grant.id}/deadlines/${d.id}`, OWNER, {
      assigneeEmail: "b@literacy.example",
    }, "PATCH"));
    expect(moved.data.assigneeNotified).toBe(true);
    expect(w.sent.map((m) => (m as Record<string, any>).recipient.address)).toEqual(["a@literacy.example", "b@literacy.example"]);

    await post(w, `/v1/organizations/${ORG}/grants/${grant.id}`, OWNER, { status: "declined" }, "PATCH");
    const refused = await post(w, `/v1/organizations/${ORG}/grants/${grant.id}/deadlines`, OWNER, {
      kind: "other", title: "Anything", dueOn: "2027-11-01",
    });
    expect(refused.status).toBe(409);
  });

  it("rejects a bad kind, a non-date and a malformed email", async () => {
    const w = world();
    const grant = await createGrant(w);
    const res = await post(w, `/v1/organizations/${ORG}/grants/${grant.id}/deadlines`, OWNER, {
      kind: "essay", title: "X", dueOn: "next week", assigneeEmail: "not-an-email",
    });
    expect(res.status).toBe(422);
    expect(Object.keys((await json(res)).error.details.fields).sort()).toEqual(["assigneeEmail", "dueOn", "kind"]);
  });
});

describe("award letters in R2", () => {
  it("stores the letter and serves it back byte-for-byte with its SHA-256", async () => {
    const w = world();
    const grant = await createGrant(w);
    const bytes = pdf("Hollis award letter");
    const up = await call(w, `/v1/organizations/${ORG}/grants/${grant.id}/documents?kind=award_letter`, {
      method: "POST",
      headers: { ...as(MEMBER), "content-type": "application/pdf", "x-filename": "Hollis award 2027.pdf" },
      body: bytes,
    });
    expect(up.status).toBe(201);
    const doc = (await json(up)).data.document;
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(doc.id).toMatch(/^gdc_[0-9a-f]{32}$/);
    expect(doc.kind).toBe("award_letter");
    expect(doc.sha256).toBe(sha);
    expect(doc.filename).toBe("Hollis award 2027.pdf");
    expect(doc.byteSize).toBe(bytes.byteLength);

    // Stored under the org's prefix, never overwritten.
    const keys = [...w.r2.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^orgs/${ORG_UUID}/grants/[0-9a-f-]{36}/[0-9a-f-]{36}$`));

    const down = await call(w, `/v1/organizations/${ORG}/grants/${grant.id}/documents/${doc.id}`, { headers: as(VIEWER) });
    expect(down.status).toBe(200);
    expect(down.headers.get("content-type")).toBe("application/pdf");
    expect(down.headers.get("x-content-sha256")).toBe(sha);
    const back = new Uint8Array(await down.arrayBuffer());
    expect(createHash("sha256").update(back).digest("hex")).toBe(sha);

    const detail = await json(await call(w, `/v1/organizations/${ORG}/grants/${grant.id}`, { headers: as(OWNER) }));
    expect(detail.data.documents).toHaveLength(1);

    expect((await call(w, `/v1/organizations/${ORG}/grants/${grant.id}/documents/${doc.id}`, { headers: as(STRANGER) })).status).toBe(404);
    const audit = w.db.prepare("SELECT event_type FROM events_audit_entries WHERE event_type = 'grant.document.uploaded'").all();
    expect(audit).toHaveLength(1);
  });

  it("refuses the wrong type, an empty file, a viewer, and an unknown kind", async () => {
    const w = world();
    const grant = await createGrant(w);
    const path = `/v1/organizations/${ORG}/grants/${grant.id}/documents`;
    const exe = await call(w, path, { method: "POST", headers: { ...as(OWNER), "content-type": "application/x-msdownload" }, body: pdf("x") });
    expect(exe.status).toBe(415);
    const empty = await call(w, path, { method: "POST", headers: { ...as(OWNER), "content-type": "application/pdf" }, body: new Uint8Array(0) });
    expect(empty.status).toBe(422);
    const viewer = await call(w, path, { method: "POST", headers: { ...as(VIEWER), "content-type": "application/pdf" }, body: pdf("x") });
    expect(viewer.status).toBe(404);
    const kind = await call(w, `${path}?kind=budget`, { method: "POST", headers: { ...as(OWNER), "content-type": "application/pdf" }, body: pdf("x") });
    expect(kind.status).toBe(422);
    expect(w.r2.objects.size).toBe(0);
  });
});
