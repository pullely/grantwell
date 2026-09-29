/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { route } from "@grant-worker/router";
import { orgPublicId } from "@grant-worker/ids";
import { runDigest, weekOf } from "@grant-worker/portfolio";
import { OWNER, as, json, world, type TestWorld } from "./harness";

// The grant writer's portfolio over a real SQLite engine. membership-worker and
// identity-worker are stand-ins driven by `w.directory` / `w.emails`: the
// directory is the only source of which organizations a user is in.

const WRITER = "44444444-4444-4444-8444-444444444444";
const SOLO = "55555555-5555-4555-8555-555555555555";
const ORGS = [1, 2, 3, 4].map((n, i) => ({
  orgId: `c${n}c${n}c${n}c${n}-cccc-4ccc-8ccc-cccccccccc0${n}`,
  name: `Nonprofit ${i + 1}`,
  slug: `nonprofit-${i + 1}`,
}));
const BASE = "https://grant.internal";
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function call(w: TestWorld, path: string, init: RequestInit = {}): Promise<Response> {
  return route(new Request(`${BASE}${path}`, init), w.env);
}

async function post(w: TestWorld, path: string, body: unknown): Promise<Record<string, any>> {
  const res = await call(w, path, { method: "POST", headers: { ...as(OWNER), "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return (await json(res)).data;
}

/** A grant with two open deadlines (one overdue) in each org; org i also has one on-time submission when i is even. */
async function seed(w: TestWorld): Promise<void> {
  for (const [i, o] of ORGS.entries()) {
    const org = orgPublicId(o.orgId);
    const grant = (await post(w, `/v1/organizations/${org}/grants`, { title: `Grant ${i + 1}`, funderName: `Funder ${i + 1}` })).grant;
    await post(w, `/v1/organizations/${org}/grants/${grant.id}/deadlines`, { kind: "narrative_report", title: `Report ${i + 1}`, dueOn: day(5 + i), assigneeEmail: `staff${i + 1}@example.org` });
    await post(w, `/v1/organizations/${org}/grants/${grant.id}/deadlines`, { kind: "deliverable", title: `Late ${i + 1}`, dueOn: day(-2) });
    if (i % 2 === 0) {
      const done = (await post(w, `/v1/organizations/${org}/grants/${grant.id}/deadlines`, { kind: "other", title: `Done ${i + 1}`, dueOn: day(20) })).deadline;
      const res = await call(w, `/v1/organizations/${org}/grants/${grant.id}/deadlines/${done.id}`, {
        method: "PATCH",
        headers: { ...as(OWNER), "content-type": "application/json" },
        body: JSON.stringify({ status: "submitted" }),
      });
      expect(res.status).toBe(200);
    }
  }
}

describe("GET /v1/me/grant-portfolio", () => {
  it("shows exactly the caller's three organizations and never a fourth's deadlines", async () => {
    const w = world();
    await seed(w);
    w.directory.set(WRITER, ORGS.slice(0, 3));

    const res = await call(w, "/v1/me/grant-portfolio", { headers: as(WRITER) });
    expect(res.status).toBe(200);
    const p = (await json(res)).data;
    expect(p.organizations.map((o: any) => o.org.name)).toEqual(["Nonprofit 1", "Nonprofit 2", "Nonprofit 3"]);
    expect(p.organizations[0].org.id).toBe(orgPublicId(ORGS[0]!.orgId));
    expect(p.organizations[0].stats).toEqual({ open: 2, overdue: 1, dueNext30: 1, submitted: 1, submittedOnTime: 1, onTimeRate: 1 });
    expect(p.organizations[1].stats.onTimeRate).toBeNull();
    expect(p.organizations[0].nextDeadline.title).toBe("Late 1"); // the earliest open one, overdue included

    const orgIds = new Set(p.deadlines.map((d: any) => d.orgId));
    expect([...orgIds].sort()).toEqual(ORGS.slice(0, 3).map((o) => orgPublicId(o.orgId)).sort());
    expect(p.deadlines).toHaveLength(6);
    expect(p.deadlines.some((d: any) => d.title.endsWith(" 4"))).toBe(false);
    expect(p.deadlines[0].dueOn <= p.deadlines[5].dueOn).toBe(true);
    expect(p.deadlines[0].orgName).toMatch(/^Nonprofit [123]$/);
    expect(p.totals).toMatchObject({ open: 6, overdue: 3, submitted: 2, submittedOnTime: 2, onTimeRate: 1 });
  });

  it("is empty for a user in no organization, 401 without an actor, and 503 when membership is down", async () => {
    const w = world();
    await seed(w);
    const empty = (await json(await call(w, "/v1/me/grant-portfolio", { headers: as(SOLO) }))).data;
    expect(empty.organizations).toEqual([]);
    expect(empty.deadlines).toEqual([]);
    expect((await call(w, "/v1/me/grant-portfolio")).status).toBe(401);
    expect((await call(w, "/v1/me/grant-portfolio", { method: "POST", headers: as(WRITER) })).status).toBe(405);
    w.directory.fail = true;
    expect((await call(w, "/v1/me/grant-portfolio", { headers: as(WRITER) })).status).toBe(503);
  });
});

describe("the weekly digest", () => {
  it("computes the week from Monday", () => {
    expect(weekOf("2027-03-08")).toBe("2027-03-08"); // Monday
    expect(weekOf("2027-03-10")).toBe("2027-03-08");
    expect(weekOf("2027-03-14")).toBe("2027-03-08"); // Sunday
    expect(weekOf("2027-03-15")).toBe("2027-03-15");
  });

  it("sends each multi-org writer one digest a week, however many sweeps run", async () => {
    const w = world();
    await seed(w);
    w.directory.set(WRITER, ORGS.slice(0, 3));
    w.directory.set(SOLO, ORGS.slice(3));
    w.emails.set(WRITER, "Writer@Freelance.example");
    w.emails.set(SOLO, "solo@example.org");
    const monday = new Date(`${weekOf(day(0))}T13:00:00Z`);

    const first = await runDigest(w.env, monday);
    expect(first).toMatchObject({ weekOf: weekOf(day(0)), writers: 1, sent: 1 });
    const second = await runDigest(w.env, monday);
    expect(second).toMatchObject({ writers: 1, sent: 0, skipped: 1 });

    const digests = (w.sent as any[]).filter((n) => n.templateKey === "grant.portfolio.digest");
    expect(digests).toHaveLength(1);
    expect(digests[0].recipient.address).toBe("writer@freelance.example");
    expect(digests[0].templateData).toMatchObject({ orgCount: 3, open: 6, overdue: 3 });
    expect(String(digests[0].templateData.lines).split("\n")).toHaveLength(6);
    expect(String(digests[0].templateData.lines)).not.toContain("Nonprofit 4");

    const nextWeek = new Date(monday.getTime() + 7 * 86_400_000);
    expect((await runDigest(w.env, nextWeek)).sent).toBe(1);
  });

  it("lets a writer send this week's digest to themself, once", async () => {
    const w = world();
    await seed(w);
    w.directory.set(WRITER, ORGS.slice(0, 2));
    const headers = { ...as(WRITER), "x-actor-email": "writer@freelance.example" };
    const first = (await json(await call(w, "/v1/me/grant-portfolio/digest", { method: "POST", headers }))).data;
    expect(first).toMatchObject({ sent: true, organizations: 2, lines: 4 });
    const again = (await json(await call(w, "/v1/me/grant-portfolio/digest", { method: "POST", headers }))).data;
    expect(again).toMatchObject({ sent: false, reason: "already_sent" });
    // …and the Monday sweep this week has nothing left to send them.
    w.emails.set(WRITER, "writer@freelance.example");
    expect((await runDigest(w.env, new Date())).sent).toBe(0);

    w.directory.set(SOLO, ORGS.slice(3));
    const solo = (await json(await call(w, "/v1/me/grant-portfolio/digest", { method: "POST", headers: { ...as(SOLO), "x-actor-email": "s@x.org" } }))).data;
    expect(solo).toMatchObject({ sent: false, reason: "fewer_than_two_organizations" });
    expect((await call(w, "/v1/me/grant-portfolio/digest", { method: "POST", headers: as(WRITER) })).status).toBe(403);
  });
});
