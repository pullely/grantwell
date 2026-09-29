/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { grantReminderRung } from "@saas/contracts/grant";
import { route } from "@grant-worker/router";
import { orgPublicId } from "@grant-worker/ids";
import { reminderRecipients, runReminders } from "@grant-worker/reminders";
import { MEMBER, OWNER, STRANGER, VIEWER, as, json, world, type TestWorld } from "./harness";

// The ladder is driven by an injected clock over a real SQLite engine: the
// same runReminders the 13:00 UTC cron calls, with `now` chosen by the test.

const ORG_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = orgPublicId(ORG_UUID);
const OTHER_ORG = orgPublicId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const BASE = "https://grant.internal";
const TODAY = "2027-03-10";
const at = (date: string): Date => new Date(`${date}T13:00:00Z`);

function call(w: TestWorld, path: string, init: RequestInit = {}): Promise<Response> {
  return route(new Request(`${BASE}${path}`, init), w.env);
}

function post(w: TestWorld, path: string, who: string, body: unknown, method = "POST"): Promise<Response> {
  return call(w, path, { method, headers: { ...as(who), "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function grantIn(w: TestWorld, org: string, leadEmail: string | null = "ed@literacy.example"): Promise<string> {
  const res = await post(w, `/v1/organizations/${org}/grants`, OWNER, {
    title: "2027 After-School Literacy",
    funderName: "Hollis Family Foundation",
    leadEmail,
  });
  expect(res.status).toBe(201);
  return (await json(res)).data.grant.id;
}

async function deadlineIn(
  w: TestWorld,
  org: string,
  grantId: string,
  dueOn: string,
  assigneeEmail: string | null = "program@literacy.example",
): Promise<string> {
  const res = await post(w, `/v1/organizations/${org}/grants/${grantId}/deadlines`, OWNER, {
    kind: "narrative_report",
    title: "Interim narrative report",
    dueOn,
    assigneeEmail,
  });
  expect(res.status).toBe(201);
  return (await json(res)).data.deadline.id;
}

/** Reminder emails only (the assignment email is sent on create). */
function reminders(w: TestWorld): any[] {
  return (w.sent as any[]).filter((n) => n.templateKey === "grant.deadline.reminder");
}

function auditCount(w: TestWorld, type: string): number {
  return (w.db.prepare("SELECT COUNT(*) AS n FROM events_audit_entries WHERE event_type = ?").get(type) as { n: number }).n;
}

describe("the ladder", () => {
  it("puts a deadline on the last rung it has reached", () => {
    expect(grantReminderRung(45)).toBeNull();
    expect(grantReminderRung(31)).toBeNull();
    expect(grantReminderRung(30)).toBe("d30");
    expect(grantReminderRung(20)).toBe("d30");
    expect(grantReminderRung(14)).toBe("d14");
    expect(grantReminderRung(8)).toBe("d14");
    expect(grantReminderRung(7)).toBe("d7");
    expect(grantReminderRung(2)).toBe("d7");
    expect(grantReminderRung(1)).toBe("d1");
    expect(grantReminderRung(0)).toBe("d0");
    expect(grantReminderRung(-1)).toBe("late1");
    expect(grantReminderRung(-6)).toBe("late1");
    expect(grantReminderRung(-7)).toBe("late7");
    expect(grantReminderRung(-30)).toBe("late7");
    expect(grantReminderRung(-31)).toBeNull();
  });

  it("adds the grant lead only on escalation rungs, or when nobody is assigned", () => {
    expect(reminderRecipients({ assigneeEmail: "A@x.org", grantLeadEmail: "lead@x.org" }, false)).toEqual({
      recipients: ["a@x.org"],
      escalated: false,
    });
    expect(reminderRecipients({ assigneeEmail: "a@x.org", grantLeadEmail: "lead@x.org" }, true)).toEqual({
      recipients: ["a@x.org", "lead@x.org"],
      escalated: true,
    });
    expect(reminderRecipients({ assigneeEmail: "lead@x.org", grantLeadEmail: "LEAD@x.org" }, true)).toEqual({
      recipients: ["lead@x.org"],
      escalated: false,
    });
    expect(reminderRecipients({ assigneeEmail: null, grantLeadEmail: "lead@x.org" }, false).recipients).toEqual(["lead@x.org"]);
    expect(reminderRecipients({ assigneeEmail: null, grantLeadEmail: null }, true).recipients).toEqual([]);
  });
});

describe("the daily sweep", () => {
  it("sends a due rung exactly once across two sweeps run back to back", async () => {
    const w = world();
    const grant = await grantIn(w, ORG);
    const deadline = await deadlineIn(w, ORG, grant, "2027-03-17"); // 7 days out

    const first = await runReminders(w.env, at(TODAY));
    expect(first.today).toBe(TODAY);
    expect(first.claimed).toHaveLength(1);
    expect(first.claimed[0]).toMatchObject({ deadlineId: deadline, rung: "d7", daysRemaining: 7, escalated: false });
    expect(first.claimed[0]!.recipients).toEqual(["program@literacy.example"]);

    const second = await runReminders(w.env, at(TODAY));
    expect(second.considered).toBe(1);
    expect(second.claimed).toHaveLength(0);

    expect(reminders(w)).toHaveLength(1);
    expect(reminders(w)[0].recipient.address).toBe("program@literacy.example");
    expect(reminders(w)[0].templateData).toMatchObject({ rung: "d7", daysRemaining: 7, role: "assignee", dueOn: "2027-03-17" });
    expect(auditCount(w, "grant.reminder.sent")).toBe(1);
    expect((w.db.prepare("SELECT COUNT(*) AS n FROM grant_reminders").get() as { n: number }).n).toBe(1);
  });

  it("lets only one of two concurrent sweeps claim the rung", async () => {
    const w = world();
    const grant = await grantIn(w, ORG);
    await deadlineIn(w, ORG, grant, "2027-03-24");
    const [a, b] = await Promise.all([runReminders(w.env, at(TODAY)), runReminders(w.env, at(TODAY))]);
    expect(a.claimed.length + b.claimed.length).toBe(1);
    expect(reminders(w)).toHaveLength(1);
  });

  it("walks the ladder day by day, each rung once, escalating from one day out", async () => {
    const w = world();
    const grant = await grantIn(w, ORG);
    await deadlineIn(w, ORG, grant, "2027-04-09"); // 30 days after TODAY
    const rungs: string[] = [];
    for (let day = 0; day <= 40; day++) {
      const now = new Date(at(TODAY).getTime() + day * 86_400_000);
      const run = await runReminders(w.env, now);
      await runReminders(w.env, now); // the second tick of the same day sends nothing
      for (const c of run.claimed) rungs.push(`${c.rung}:${c.recipients.length}`);
    }
    expect(rungs).toEqual(["d30:1", "d14:1", "d7:1", "d1:2", "d0:2", "late1:2", "late7:2"]);
    const lead = reminders(w).filter((n) => n.recipient.address === "ed@literacy.example");
    expect(lead.map((n) => n.templateData.rung)).toEqual(["d1", "d0", "late1", "late7"]);
    expect(lead.every((n) => n.templateData.role === "lead")).toBe(true);
  });

  it("sends an overdue deadline's reminder to the assignee and the grant lead", async () => {
    const w = world();
    const grant = await grantIn(w, ORG);
    await deadlineIn(w, ORG, grant, "2027-03-08"); // two days late
    const run = await runReminders(w.env, at(TODAY));
    expect(run.claimed).toHaveLength(1);
    expect(run.claimed[0]).toMatchObject({ rung: "late1", daysRemaining: -2, escalated: true });
    expect(reminders(w).map((n) => n.recipient.address).sort()).toEqual(["ed@literacy.example", "program@literacy.example"]);
  });

  it("sends nothing further once a deadline is submitted or waived", async () => {
    const w = world();
    const grant = await grantIn(w, ORG);
    const submitted = await deadlineIn(w, ORG, grant, "2027-03-17");
    const waived = await deadlineIn(w, ORG, grant, "2027-03-18");
    expect((await runReminders(w.env, at(TODAY))).claimed).toHaveLength(2);

    expect((await post(w, `/v1/organizations/${ORG}/grants/${grant}/deadlines/${submitted}`, OWNER, { status: "submitted" }, "PATCH")).status).toBe(200);
    expect((await post(w, `/v1/organizations/${ORG}/grants/${grant}/deadlines/${waived}`, OWNER, { status: "waived" }, "PATCH")).status).toBe(200);
    const before = reminders(w).length;
    for (const date of ["2027-03-16", "2027-03-17", "2027-03-19", "2027-03-25"]) {
      const run = await runReminders(w.env, at(date));
      expect(run.considered).toBe(0);
      expect(run.claimed).toHaveLength(0);
    }
    expect(reminders(w)).toHaveLength(before);
  });

  it("re-arms the ladder when the due date moves", async () => {
    const w = world();
    const grant = await grantIn(w, ORG);
    const deadline = await deadlineIn(w, ORG, grant, "2027-03-17");
    expect((await runReminders(w.env, at(TODAY))).claimed.map((c) => c.rung)).toEqual(["d7"]);
    expect((await runReminders(w.env, at(TODAY))).claimed).toHaveLength(0);

    // The funder grants an extension: the new date is a new ladder.
    expect((await post(w, `/v1/organizations/${ORG}/grants/${grant}/deadlines/${deadline}`, OWNER, { dueOn: "2027-03-20" }, "PATCH")).status).toBe(200);
    const moved = await runReminders(w.env, at(TODAY));
    expect(moved.claimed.map((c) => `${c.rung}@${c.dueOn}`)).toEqual(["d14@2027-03-20"]);
  });

  it("claims nothing for a deadline nobody would hear about, until someone is assigned", async () => {
    const w = world();
    const grant = await grantIn(w, ORG, null);
    const deadline = await deadlineIn(w, ORG, grant, "2027-03-17", null);
    const run = await runReminders(w.env, at(TODAY));
    expect(run.skippedNoRecipient).toBe(1);
    expect(run.claimed).toHaveLength(0);

    await post(w, `/v1/organizations/${ORG}/grants/${grant}/deadlines/${deadline}`, OWNER, { assigneeEmail: "late@literacy.example" }, "PATCH");
    const after = await runReminders(w.env, at(TODAY));
    expect(after.claimed.map((c) => c.recipients)).toEqual([["late@literacy.example"]]);
  });

  it("does not chase deadlines of a closed grant, or ones more than 30 days late or out", async () => {
    const w = world();
    const closed = await grantIn(w, ORG);
    await deadlineIn(w, ORG, closed, "2027-03-12");
    await post(w, `/v1/organizations/${ORG}/grants/${closed}`, OWNER, { status: "closed" }, "PATCH");
    const active = await grantIn(w, ORG);
    await deadlineIn(w, ORG, active, "2027-01-15"); // 54 days late
    await deadlineIn(w, ORG, active, "2027-05-01"); // 52 days out
    const run = await runReminders(w.env, at(TODAY));
    expect(run.considered).toBe(0);
    expect(run.claimed).toHaveLength(0);
  });
});

describe("the on-demand run, the calendar and the on-time rate", () => {
  it("runs today's ladder for one org only, is repeat-safe, and is writers-only", async () => {
    const w = world();
    const today = new Date().toISOString().slice(0, 10);
    const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const mine = await grantIn(w, ORG);
    await deadlineIn(w, ORG, mine, inAWeek);
    const theirs = await grantIn(w, OTHER_ORG);
    await deadlineIn(w, OTHER_ORG, theirs, inAWeek);

    const first = await json(await post(w, `/v1/organizations/${ORG}/reminders/run`, MEMBER, {}));
    expect(first.data.today).toBe(today);
    expect(first.data.claimed).toHaveLength(1);
    expect(first.data.claimed[0].rung).toBe("d7");
    const second = await json(await post(w, `/v1/organizations/${ORG}/reminders/run`, OWNER, {}));
    expect(second.data.claimed).toHaveLength(0);
    expect(reminders(w)).toHaveLength(1);

    expect((await post(w, `/v1/organizations/${ORG}/reminders/run`, VIEWER, {})).status).toBe(404);
    expect((await post(w, `/v1/organizations/${ORG}/reminders/run`, STRANGER, {})).status).toBe(404);
    expect((await call(w, `/v1/organizations/${ORG}/reminders/run`, { method: "POST" })).status).toBe(401);
    expect((await call(w, `/v1/organizations/${ORG}/reminders/run`, { headers: as(OWNER) })).status).toBe(405);
  });

  it("lists every deadline due in the month, whatever its state", async () => {
    const w = world();
    const grant = await grantIn(w, ORG);
    await deadlineIn(w, ORG, grant, "2027-02-28");
    const a = await deadlineIn(w, ORG, grant, "2027-03-01");
    const b = await deadlineIn(w, ORG, grant, "2027-03-31");
    await deadlineIn(w, ORG, grant, "2027-04-01");
    await post(w, `/v1/organizations/${ORG}/grants/${grant}/deadlines/${b}`, OWNER, { status: "submitted" }, "PATCH");

    const res = await json(await call(w, `/v1/organizations/${ORG}/deadlines/calendar?month=2027-03`, { headers: as(VIEWER) }));
    expect(res.data.month).toBe("2027-03");
    expect(res.data.deadlines.map((d: any) => d.id)).toEqual([a, b]);
    expect(res.data.deadlines[1].status).toBe("submitted");
    expect(res.data.deadlines[0].grantTitle).toBe("2027 After-School Literacy");

    const feb = await json(await call(w, `/v1/organizations/${ORG}/deadlines/calendar?month=2027-02`, { headers: as(OWNER) }));
    expect(feb.data.deadlines).toHaveLength(1);
    expect((await call(w, `/v1/organizations/${ORG}/deadlines/calendar?month=2027-13`, { headers: as(OWNER) })).status).toBe(422);
    expect((await call(w, `/v1/organizations/${ORG}/deadlines/calendar?month=2027-03`, { headers: as(STRANGER) })).status).toBe(404);
  });

  it("derives the on-time rate from submitted deadlines and counts the overdue", async () => {
    const w = world();
    const empty = await json(await call(w, `/v1/organizations/${ORG}/grants/stats`, { headers: as(VIEWER) }));
    expect(empty.data.stats).toEqual({ open: 0, overdue: 0, dueNext30: 0, submitted: 0, submittedOnTime: 0, onTimeRate: null });

    const grant = await grantIn(w, ORG);
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const early = await deadlineIn(w, ORG, grant, day(5));
    const late = await deadlineIn(w, ORG, grant, day(-3));
    await deadlineIn(w, ORG, grant, day(-1)); // open and overdue
    await deadlineIn(w, ORG, grant, day(10)); // open, due within 30 days
    await deadlineIn(w, ORG, grant, day(90)); // open, later
    await post(w, `/v1/organizations/${ORG}/grants/${grant}/deadlines/${early}`, OWNER, { status: "submitted" }, "PATCH");
    await post(w, `/v1/organizations/${ORG}/grants/${grant}/deadlines/${late}`, OWNER, { status: "submitted" }, "PATCH");

    const res = await json(await call(w, `/v1/organizations/${ORG}/grants/stats`, { headers: as(OWNER) }));
    expect(res.data.stats).toEqual({ open: 3, overdue: 1, dueNext30: 1, submitted: 2, submittedOnTime: 1, onTimeRate: 0.5 });
    expect((await call(w, `/v1/organizations/${ORG}/grants/stats`, { headers: as(STRANGER) })).status).toBe(404);
  });
});
