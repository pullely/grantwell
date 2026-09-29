import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import type {
  ClaimReminderInput,
  CreateGrantDeadlineInput,
  CreateGrantDocumentInput,
  CreateGrantInput,
  Grant,
  GrantDeadline,
  GrantDeadlineCounts,
  GrantDeadlineWithGrant,
  GrantDocument,
  GrantFields,
  GrantReminder,
  GrantRepository,
  ListDeadlinesFilter,
  ReminderCandidate,
  ReminderCandidateFilter,
  UpdateGrantDeadlineInput,
} from "./types.js";

/** D1 binds at most 100 parameters per statement; IN lists are chunked below it. */
const IN_CHUNK = 90;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

type Row = SqlRow & Record<string, unknown>;

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapGrant(row: Row): Grant {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    title: row.title as string,
    funderName: row.funder_name as string,
    funderContactName: str(row.funder_contact_name),
    funderContactEmail: str(row.funder_contact_email),
    amountCents: num(row.amount_cents),
    currency: row.currency as string,
    periodStart: str(row.period_start),
    periodEnd: str(row.period_end),
    status: row.status as string,
    restrictions: (row.restrictions as string) ?? "",
    leadEmail: str(row.lead_email),
    notes: (row.notes as string) ?? "",
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapDeadline(row: Row): GrantDeadline {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    grantId: row.grant_id as string,
    kind: row.kind as string,
    title: row.title as string,
    dueOn: row.due_on as string,
    assigneeEmail: str(row.assignee_email),
    status: row.status as string,
    submittedAt: str(row.submitted_at),
    notes: (row.notes as string) ?? "",
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapDocument(row: Row): GrantDocument {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    grantId: row.grant_id as string,
    kind: row.kind as string,
    objectKey: row.object_key as string,
    filename: row.filename as string,
    contentType: row.content_type as string,
    byteSize: Number(row.byte_size),
    sha256: row.sha256 as string,
    uploadedBy: str(row.uploaded_by),
    uploadedAt: row.uploaded_at as string,
  };
}

const GRANT_COLUMNS = `id, org_id, title, funder_name, funder_contact_name, funder_contact_email,
  amount_cents, currency, period_start, period_end, status, restrictions, lead_email, notes,
  created_by, created_at, updated_at`;

const DEADLINE_COLUMNS = `id, org_id, grant_id, kind, title, due_on, assignee_email, status,
  submitted_at, notes, created_by, created_at, updated_at`;

const DOCUMENT_COLUMNS = `id, org_id, grant_id, kind, object_key, filename, content_type,
  byte_size, sha256, uploaded_by, uploaded_at`;

export function createGrantRepository(executor: SqlExecutor): GrantRepository {
  async function one(sql: string, params: unknown[]): Promise<Row | null> {
    const result = await executor.execute<Row>(sql, params);
    return result.rows[0] ?? null;
  }

  function grantParams(f: GrantFields): unknown[] {
    return [
      f.title,
      f.funderName,
      f.funderContactName,
      f.funderContactEmail,
      f.amountCents,
      f.currency,
      f.periodStart,
      f.periodEnd,
      f.status,
      f.restrictions,
      f.leadEmail,
      f.notes,
    ];
  }

  return {
    async createGrant(input: CreateGrantInput) {
      const row = await one(
        `INSERT INTO grant_grants
           (id, org_id, title, funder_name, funder_contact_name, funder_contact_email,
            amount_cents, currency, period_start, period_end, status, restrictions,
            lead_email, notes, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
         RETURNING ${GRANT_COLUMNS}`,
        [input.id, input.orgId, ...grantParams(input), input.createdBy, input.now],
      );
      if (!row) throw new Error("grant: insert returned no row");
      return mapGrant(row);
    },

    async getGrant(orgId, grantId) {
      const row = await one(`SELECT ${GRANT_COLUMNS} FROM grant_grants WHERE org_id = $1 AND id = $2`, [orgId, grantId]);
      return row ? mapGrant(row) : null;
    },

    async listGrants(orgId, status) {
      const params: unknown[] = [orgId];
      let where = "org_id = $1";
      if (status) {
        params.push(status);
        where += " AND status = $2";
      }
      const result = await executor.execute<Row>(
        `SELECT ${GRANT_COLUMNS} FROM grant_grants WHERE ${where}
          ORDER BY created_at DESC, id DESC LIMIT 500`,
        params,
      );
      return result.rows.map(mapGrant);
    },

    async updateGrant(orgId, grantId, fields: GrantFields, now) {
      const row = await one(
        `UPDATE grant_grants SET
           title = $3, funder_name = $4, funder_contact_name = $5, funder_contact_email = $6,
           amount_cents = $7, currency = $8, period_start = $9, period_end = $10, status = $11,
           restrictions = $12, lead_email = $13, notes = $14, updated_at = $15
         WHERE org_id = $1 AND id = $2
         RETURNING ${GRANT_COLUMNS}`,
        [orgId, grantId, ...grantParams(fields), now],
      );
      return row ? mapGrant(row) : null;
    },

    async createDeadline(input: CreateGrantDeadlineInput) {
      const row = await one(
        `INSERT INTO grant_deadlines
           (id, org_id, grant_id, kind, title, due_on, assignee_email, status, notes,
            created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $10)
         RETURNING ${DEADLINE_COLUMNS}`,
        [
          input.id,
          input.orgId,
          input.grantId,
          input.kind,
          input.title,
          input.dueOn,
          input.assigneeEmail,
          input.notes,
          input.createdBy,
          input.now,
        ],
      );
      if (!row) throw new Error("grant: deadline insert returned no row");
      return mapDeadline(row);
    },

    async getDeadline(orgId, grantId, deadlineId) {
      const row = await one(
        `SELECT ${DEADLINE_COLUMNS} FROM grant_deadlines WHERE org_id = $1 AND grant_id = $2 AND id = $3`,
        [orgId, grantId, deadlineId],
      );
      return row ? mapDeadline(row) : null;
    },

    async listDeadlinesForGrant(orgId, grantId) {
      const result = await executor.execute<Row>(
        `SELECT ${DEADLINE_COLUMNS} FROM grant_deadlines
          WHERE org_id = $1 AND grant_id = $2
          ORDER BY due_on ASC, created_at ASC, id ASC`,
        [orgId, grantId],
      );
      return result.rows.map(mapDeadline);
    },

    async listDeadlines(orgId, filter: ListDeadlinesFilter) {
      const params: unknown[] = [orgId];
      let where = "d.org_id = $1";
      if (filter.status) {
        params.push(filter.status);
        where += ` AND d.status = $${params.length}`;
      }
      if (filter.from) {
        params.push(filter.from);
        where += ` AND d.due_on >= $${params.length}`;
      }
      if (filter.through) {
        params.push(filter.through);
        where += ` AND d.due_on <= $${params.length}`;
      }
      params.push(filter.limit);
      const result = await executor.execute<Row>(
        `SELECT d.id, d.org_id, d.grant_id, d.kind, d.title, d.due_on, d.assignee_email, d.status,
                d.submitted_at, d.notes, d.created_by, d.created_at, d.updated_at,
                g.title AS grant_title, g.funder_name AS grant_funder_name
           FROM grant_deadlines d
           JOIN grant_grants g ON g.id = d.grant_id AND g.org_id = d.org_id
          WHERE ${where}
          ORDER BY d.due_on ASC, d.created_at ASC, d.id ASC
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(
        (row): GrantDeadlineWithGrant => ({
          ...mapDeadline(row),
          grantTitle: row.grant_title as string,
          funderName: row.grant_funder_name as string,
        }),
      );
    },

    async nextOpenDeadlines(orgId, grantIds) {
      const wanted = new Set(grantIds);
      const out = new Map<string, GrantDeadline>();
      if (wanted.size === 0) return out;
      // One scan of the org's open deadlines in due order; the first seen per
      // grant is its next one. Avoids an IN list that could exceed D1's bind limit.
      const result = await executor.execute<Row>(
        `SELECT ${DEADLINE_COLUMNS} FROM grant_deadlines
          WHERE org_id = $1 AND status = 'open'
          ORDER BY due_on ASC, created_at ASC, id ASC`,
        [orgId],
      );
      for (const row of result.rows) {
        const d = mapDeadline(row);
        if (wanted.has(d.grantId) && !out.has(d.grantId)) out.set(d.grantId, d);
      }
      return out;
    },

    async updateDeadline(orgId, grantId, deadlineId, input: UpdateGrantDeadlineInput) {
      const row = await one(
        `UPDATE grant_deadlines SET
           kind = $4, title = $5, due_on = $6, assignee_email = $7, status = $8,
           submitted_at = $9, notes = $10, updated_at = $11
         WHERE org_id = $1 AND grant_id = $2 AND id = $3
         RETURNING ${DEADLINE_COLUMNS}`,
        [
          orgId,
          grantId,
          deadlineId,
          input.kind,
          input.title,
          input.dueOn,
          input.assigneeEmail,
          input.status,
          input.submittedAt,
          input.notes,
          input.now,
        ],
      );
      return row ? mapDeadline(row) : null;
    },

    async listReminderCandidates(filter: ReminderCandidateFilter) {
      const params: unknown[] = [filter.from, filter.through];
      let where = "d.status = 'open' AND g.status = 'active' AND d.due_on >= $1 AND d.due_on <= $2";
      if (filter.orgId) {
        params.push(filter.orgId);
        where += ` AND d.org_id = $${params.length}`;
      }
      params.push(filter.limit);
      const result = await executor.execute<Row>(
        `SELECT d.id, d.org_id, d.grant_id, d.kind, d.title, d.due_on, d.assignee_email, d.status,
                d.submitted_at, d.notes, d.created_by, d.created_at, d.updated_at,
                g.title AS grant_title, g.funder_name AS grant_funder_name, g.lead_email AS grant_lead_email
           FROM grant_deadlines d
           JOIN grant_grants g ON g.id = d.grant_id AND g.org_id = d.org_id
          WHERE ${where}
          ORDER BY d.due_on ASC, d.id ASC
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(
        (row): ReminderCandidate => ({
          ...mapDeadline(row),
          grantTitle: row.grant_title as string,
          funderName: row.grant_funder_name as string,
          grantLeadEmail: str(row.grant_lead_email),
        }),
      );
    },

    async claimReminder(input: ClaimReminderInput) {
      const result = await executor.execute<Row>(
        `INSERT INTO grant_reminders (id, org_id, deadline_id, rung, due_on, recipients, escalated, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (deadline_id, rung, due_on) DO NOTHING
         RETURNING id`,
        [
          input.id,
          input.orgId,
          input.deadlineId,
          input.rung,
          input.dueOn,
          input.recipients,
          input.escalated ? 1 : 0,
          input.sentAt,
        ],
      );
      return result.rows.length === 1;
    },

    async listReminders(orgId, deadlineId) {
      const result = await executor.execute<Row>(
        `SELECT id, org_id, deadline_id, rung, due_on, recipients, escalated, sent_at
           FROM grant_reminders WHERE org_id = $1 AND deadline_id = $2
          ORDER BY sent_at ASC, id ASC`,
        [orgId, deadlineId],
      );
      return result.rows.map(
        (row): GrantReminder => ({
          id: row.id as string,
          orgId: row.org_id as string,
          deadlineId: row.deadline_id as string,
          rung: row.rung as string,
          dueOn: row.due_on as string,
          recipients: String(row.recipients ?? ""),
          escalated: Number(row.escalated) === 1,
          sentAt: row.sent_at as string,
        }),
      );
    },

    async deadlineCounts(orgIds, today) {
      const out = new Map<string, GrantDeadlineCounts>();
      const ids = [...new Set(orgIds)];
      const through = addDays(today, 30);
      for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const chunk = ids.slice(i, i + IN_CHUNK);
        const placeholders = chunk.map((_, j) => `$${j + 3}`).join(", ");
        const result = await executor.execute<Row>(
          `SELECT org_id,
                  SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
                  SUM(CASE WHEN status = 'open' AND due_on < $1 THEN 1 ELSE 0 END) AS overdue_count,
                  SUM(CASE WHEN status = 'open' AND due_on >= $1 AND due_on <= $2 THEN 1 ELSE 0 END) AS due_next30,
                  SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted_count,
                  SUM(CASE WHEN status = 'submitted' AND substr(submitted_at, 1, 10) <= due_on THEN 1 ELSE 0 END) AS on_time_count
             FROM grant_deadlines
            WHERE org_id IN (${placeholders})
            GROUP BY org_id`,
          [today, through, ...chunk],
        );
        for (const row of result.rows) {
          out.set(row.org_id as string, {
            open: Number(row.open_count ?? 0),
            overdue: Number(row.overdue_count ?? 0),
            dueNext30: Number(row.due_next30 ?? 0),
            submitted: Number(row.submitted_count ?? 0),
            submittedOnTime: Number(row.on_time_count ?? 0),
          });
        }
      }
      return out;
    },

    async createDocument(input: CreateGrantDocumentInput) {
      const row = await one(
        `INSERT INTO grant_documents
           (id, org_id, grant_id, kind, object_key, filename, content_type, byte_size, sha256,
            uploaded_by, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${DOCUMENT_COLUMNS}`,
        [
          input.id,
          input.orgId,
          input.grantId,
          input.kind,
          input.objectKey,
          input.filename,
          input.contentType,
          input.byteSize,
          input.sha256,
          input.uploadedBy,
          input.uploadedAt,
        ],
      );
      if (!row) throw new Error("grant: document insert returned no row");
      return mapDocument(row);
    },

    async listDocuments(orgId, grantId) {
      const result = await executor.execute<Row>(
        `SELECT ${DOCUMENT_COLUMNS} FROM grant_documents
          WHERE org_id = $1 AND grant_id = $2 ORDER BY uploaded_at ASC, id ASC`,
        [orgId, grantId],
      );
      return result.rows.map(mapDocument);
    },

    async getDocument(orgId, grantId, documentId) {
      const row = await one(
        `SELECT ${DOCUMENT_COLUMNS} FROM grant_documents WHERE org_id = $1 AND grant_id = $2 AND id = $3`,
        [orgId, grantId, documentId],
      );
      return row ? mapDocument(row) : null;
    },
  };
}
