import { createGrantRepository } from "@saas/db/grant";
import { createSqlExecutor } from "@saas/db/d1";
import { d1Over, migratedDatabase } from "./harness";

// Runbook trap 22: the D1 executor reports rowCount = rows.length, so a write
// without RETURNING always reports 0 on D1, whatever it changed. These run the
// real executor over a real SQLite engine — the combination a mocked executor
// hides — and pin that the grant repository decides "did my write happen?" from
// RETURNING rows, never from rowCount.

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "2026-09-23T10:00:00.000Z";

const FIELDS = {
  title: "Literacy",
  funderName: "Hollis",
  funderContactName: null,
  funderContactEmail: null,
  amountCents: 100_00,
  currency: "USD",
  periodStart: null,
  periodEnd: null,
  status: "active",
  restrictions: "",
  leadEmail: null,
  notes: "",
};

describe("trap 22: rowCount after a write on D1", () => {
  it("is 0 for an UPDATE without RETURNING even though the row changed", async () => {
    const executor = createSqlExecutor(d1Over(migratedDatabase()));
    const repo = createGrantRepository(executor);
    const grant = await repo.createGrant({ id: crypto.randomUUID(), orgId: ORG, ...FIELDS, createdBy: null, now: NOW });

    const bare = await executor.execute(`UPDATE grant_grants SET title = $2 WHERE id = $1`, [grant.id, "Numeracy"]);
    expect(bare.rowCount).toBe(0); // the trap: the row DID change
    expect((await repo.getGrant(ORG, grant.id))?.title).toBe("Numeracy");

    const returning = await executor.execute(`UPDATE grant_grants SET title = $2 WHERE id = $1 RETURNING id`, [grant.id, "Literacy"]);
    expect(returning.rowCount).toBe(1);
  });

  it("the repository's updates report their outcome through RETURNING, scoped by org", async () => {
    const repo = createGrantRepository(createSqlExecutor(d1Over(migratedDatabase())));
    const grant = await repo.createGrant({ id: crypto.randomUUID(), orgId: ORG, ...FIELDS, createdBy: null, now: NOW });
    const deadline = await repo.createDeadline({
      id: crypto.randomUUID(), orgId: ORG, grantId: grant.id, kind: "deliverable", title: "D", dueOn: "2027-01-01",
      assigneeEmail: null, notes: "", createdBy: null, now: NOW,
    });
    const patch = {
      kind: "deliverable", title: "D", dueOn: "2027-01-01", assigneeEmail: null,
      status: "submitted", submittedAt: NOW, notes: "", now: NOW,
    };

    expect(await repo.updateDeadline(OTHER, grant.id, deadline.id, patch)).toBeNull(); // another org: nothing changed
    const updated = await repo.updateDeadline(ORG, grant.id, deadline.id, patch);
    expect(updated?.status).toBe("submitted");
    expect(updated?.submittedAt).toBe(NOW);

    expect(await repo.updateGrant(OTHER, grant.id, FIELDS, NOW)).toBeNull();
    expect((await repo.updateGrant(ORG, grant.id, { ...FIELDS, status: "closed" }, NOW))?.status).toBe("closed");
  });

  it("the schema holds submitted_at to the status", async () => {
    const db = migratedDatabase();
    const repo = createGrantRepository(createSqlExecutor(d1Over(db)));
    const grant = await repo.createGrant({ id: crypto.randomUUID(), orgId: ORG, ...FIELDS, createdBy: null, now: NOW });
    const deadline = await repo.createDeadline({
      id: crypto.randomUUID(), orgId: ORG, grantId: grant.id, kind: "other", title: "D", dueOn: "2027-01-01",
      assigneeEmail: null, notes: "", createdBy: null, now: NOW,
    });
    expect(() => db.prepare("UPDATE grant_deadlines SET status = 'submitted' WHERE id = ?").run(deadline.id)).toThrow();
  });
});
