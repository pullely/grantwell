import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1ApiAdapter } from "@saas/db/runner";
import { route } from "@membership-worker/router";
import type { Env } from "@membership-worker/env";

// Grantwell GW3 — the two service-binding-only directory routes, over a real
// SQLite engine with every migration applied (D1 is SQLite).

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const dir of readdirSync(MIGRATIONS_ROOT).filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql"))).sort()) {
    for (const statement of D1ApiAdapter.splitStatements(readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8"))) db.exec(statement);
  }
  return db;
}

function d1Over(db: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all<T>() {
          return Promise.resolve({ results: db.prepare(query).all(...(bound as never[])) as T[], success: true, meta: {} });
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

const WRITER = "44444444-4444-4444-8444-444444444444";
const STAFF = "55555555-5555-4555-8555-555555555555";
const GONE = "66666666-6666-4666-8666-666666666666";

function seed(db: DatabaseSync): void {
  const org = db.prepare("INSERT INTO membership_organizations (id, name, slug, slug_lower, status) VALUES (?, ?, ?, ?, ?)");
  org.run("o1", "Beacon Arts", "beacon", "beacon", "active");
  org.run("o2", "Ada Literacy", "ada", "ada", "active");
  org.run("o3", "Cedar Food Bank", "cedar", "cedar", "active");
  org.run("o4", "Dormant Trust", "dormant", "dormant", "suspended");
  const member = db.prepare("INSERT INTO membership_organization_members (id, org_id, subject_id, subject_type, status) VALUES (?, ?, ?, 'user', ?)");
  member.run("m1", "o1", WRITER, "active");
  member.run("m2", "o2", WRITER, "active");
  member.run("m3", "o3", WRITER, "removed");
  member.run("m4", "o4", WRITER, "active");
  member.run("m5", "o1", STAFF, "active");
  member.run("m6", "o1", GONE, "active");
  member.run("m7", "o2", GONE, "active");
  const user = db.prepare("INSERT INTO identity_users (id, email, email_lower, status) VALUES (?, ?, ?, ?)");
  user.run(WRITER, "Writer@Freelance.example", "writer@freelance.example", "active");
  user.run(STAFF, "staff@beacon.example", "staff@beacon.example", "active");
  user.run(GONE, "gone@example.org", "gone@example.org", "deleted");
}

function env(db: DatabaseSync): Env {
  return { ENVIRONMENT: "test", PLATFORM_DB: d1Over(db) } as Env;
}

function post(e: Env, path: string, body: unknown): Promise<Response> {
  return route(
    new Request(`http://membership-worker${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    e,
  );
}

describe("GW3 membership directory routes", () => {
  it("lists a subject's active organizations it actively belongs to, by name", async () => {
    const db = migrated();
    seed(db);
    const res = await post(env(db), "/v1/internal/membership/subject-organizations", { subject: { type: "user", id: WRITER } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { organizations: { orgId: string; name: string; slug: string }[] } };
    expect(body.data.organizations).toEqual([
      { orgId: "o2", name: "Ada Literacy", slug: "ada" },
      { orgId: "o1", name: "Beacon Arts", slug: "beacon" },
    ]);
    const nobody = (await (await post(env(db), "/v1/internal/membership/subject-organizations", { subject: { type: "user", id: "x" } })).json()) as {
      data: { organizations: unknown[] };
    };
    expect(nobody.data.organizations).toEqual([]);
    expect((await post(env(db), "/v1/internal/membership/subject-organizations", { subject: {} })).status).toBe(422);
  });

  it("lists every active user in two or more active organizations, with their address", async () => {
    const db = migrated();
    seed(db);
    const res = await post(env(db), "/v1/internal/membership/multi-org-subjects", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { subjects: { subjectId: string; email: string; organizations: { orgId: string }[] }[] } };
    // WRITER: o1 + o2 (o3 removed, o4 suspended). STAFF: one org. GONE: deleted user.
    expect(body.data.subjects).toHaveLength(1);
    expect(body.data.subjects[0]!.subjectId).toBe(WRITER);
    expect(body.data.subjects[0]!.email).toBe("Writer@Freelance.example");
    expect(body.data.subjects[0]!.organizations.map((o) => o.orgId)).toEqual(["o2", "o1"]);

    const one = (await (await post(env(db), "/v1/internal/membership/multi-org-subjects", { minOrganizations: 1 })).json()) as {
      data: { subjects: { subjectId: string }[] };
    };
    expect(one.data.subjects.map((s) => s.subjectId).sort()).toEqual([WRITER, STAFF].sort());
    expect((await post(env(db), "/v1/internal/membership/multi-org-subjects", { minOrganizations: 0 })).status).toBe(422);
  });

  it("answers only POST", async () => {
    const db = migrated();
    const res = await route(new Request("http://membership-worker/v1/internal/membership/multi-org-subjects"), env(db));
    expect(res.status).toBe(405);
  });
});
