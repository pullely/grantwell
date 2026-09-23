import {
  GRANT_DEADLINE_KINDS,
  GRANT_DEADLINE_STATUSES,
  GRANT_DOCUMENT_KINDS,
  GRANT_STATUSES,
  type GrantDeadlineKind,
  type GrantDeadlineStatus,
  type GrantDocumentKind,
  type GrantStatus,
} from "@saas/contracts/grant";
import type { Grant, GrantFields } from "@saas/db/grant";

export type Validation<T> = { valid: true; value: T } | { valid: false; fields: Record<string, string[]> };

// No ':' anywhere: an address is part of a notification idempotency key.
const EMAIL_RE = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_AMOUNT_CENTS = 1_000_000_000_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

class Collector {
  fields: Record<string, string[]> = {};
  add(field: string, message: string): void {
    (this.fields[field] ??= []).push(message);
  }
  get ok(): boolean {
    return Object.keys(this.fields).length === 0;
  }
}

/** undefined = absent; null = explicitly cleared; string = the trimmed value. */
function text(
  c: Collector,
  body: Record<string, unknown>,
  field: string,
  opts: { required: boolean; max: number },
): string | null | undefined {
  if (!(field in body)) {
    if (opts.required) c.add(field, "Required");
    return undefined;
  }
  const v = body[field];
  if (v === null || v === "") {
    if (opts.required) c.add(field, "Required");
    return null;
  }
  if (typeof v !== "string") {
    c.add(field, "Must be a string");
    return undefined;
  }
  const trimmed = v.trim();
  if (opts.required && trimmed.length === 0) c.add(field, "Required");
  if (trimmed.length > opts.max) c.add(field, `At most ${opts.max} characters`);
  return trimmed.length === 0 ? null : trimmed;
}

function email(c: Collector, body: Record<string, unknown>, field: string): string | null | undefined {
  const v = text(c, body, field, { required: false, max: 254 });
  if (typeof v === "string" && !EMAIL_RE.test(v)) c.add(field, "Not an email address");
  return typeof v === "string" ? v.toLowerCase() : v;
}

function date(c: Collector, body: Record<string, unknown>, field: string, required: boolean): string | null | undefined {
  const v = text(c, body, field, { required, max: 10 });
  if (typeof v === "string" && !isCalendarDate(v)) c.add(field, "A date as YYYY-MM-DD");
  return v;
}

function oneOf<T extends string>(
  c: Collector,
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  required: boolean,
): T | undefined {
  if (!(field in body) || body[field] === undefined) {
    if (required) c.add(field, "Required");
    return undefined;
  }
  const v = body[field];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    c.add(field, `One of ${allowed.join(", ")}`);
    return undefined;
  }
  return v as T;
}

/**
 * Validate a grant body. On create every required field must be present; on
 * update the body is a patch over `current` and absent fields keep their value.
 */
export function validateGrantBody(body: unknown, current: Grant | null): Validation<GrantFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const creating = current === null;

  const title = text(c, body, "title", { required: creating, max: 200 });
  if (!creating && title === null) c.add("title", "Required");
  const funderName = text(c, body, "funderName", { required: creating, max: 200 });
  if (!creating && funderName === null) c.add("funderName", "Required");
  const funderContactName = text(c, body, "funderContactName", { required: false, max: 200 });
  const funderContactEmail = email(c, body, "funderContactEmail");
  const leadEmail = email(c, body, "leadEmail");
  const restrictions = text(c, body, "restrictions", { required: false, max: 10_000 });
  const notes = text(c, body, "notes", { required: false, max: 10_000 });
  const periodStart = date(c, body, "periodStart", false);
  const periodEnd = date(c, body, "periodEnd", false);
  const status = oneOf<GrantStatus>(c, body, "status", GRANT_STATUSES, false);

  let amountCents: number | null | undefined;
  if ("amountCents" in body) {
    const v = body.amountCents;
    if (v === null) amountCents = null;
    else if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_AMOUNT_CENTS) {
      c.add("amountCents", "A whole number of cents from 0 to 10^12");
    } else amountCents = v;
  }
  let currency: string | undefined;
  if ("currency" in body) {
    const v = body.currency;
    if (typeof v !== "string" || !CURRENCY_RE.test(v)) c.add("currency", "A three-letter ISO 4217 code, e.g. USD");
    else currency = v;
  }

  if (!c.ok) return { valid: false, fields: c.fields };

  const merged: GrantFields = {
    title: title ?? current?.title ?? "",
    funderName: funderName ?? current?.funderName ?? "",
    funderContactName: funderContactName === undefined ? (current?.funderContactName ?? null) : funderContactName,
    funderContactEmail: funderContactEmail === undefined ? (current?.funderContactEmail ?? null) : funderContactEmail,
    amountCents: amountCents === undefined ? (current?.amountCents ?? null) : amountCents,
    currency: currency ?? current?.currency ?? "USD",
    periodStart: periodStart === undefined ? (current?.periodStart ?? null) : periodStart,
    periodEnd: periodEnd === undefined ? (current?.periodEnd ?? null) : periodEnd,
    status: status ?? current?.status ?? "active",
    restrictions: restrictions === undefined ? (current?.restrictions ?? "") : (restrictions ?? ""),
    leadEmail: leadEmail === undefined ? (current?.leadEmail ?? null) : leadEmail,
    notes: notes === undefined ? (current?.notes ?? "") : (notes ?? ""),
  };
  if (merged.periodStart && merged.periodEnd && merged.periodEnd < merged.periodStart) {
    return { valid: false, fields: { periodEnd: ["Must not be before periodStart"] } };
  }
  return { valid: true, value: merged };
}

export interface DeadlineCreateFields {
  kind: GrantDeadlineKind;
  title: string;
  dueOn: string;
  assigneeEmail: string | null;
  notes: string;
}

export function validateDeadlineCreate(body: unknown): Validation<DeadlineCreateFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const kind = oneOf<GrantDeadlineKind>(c, body, "kind", GRANT_DEADLINE_KINDS, true);
  const title = text(c, body, "title", { required: true, max: 200 });
  const dueOn = date(c, body, "dueOn", true);
  const assigneeEmail = email(c, body, "assigneeEmail");
  const notes = text(c, body, "notes", { required: false, max: 5000 });
  if (!c.ok) return { valid: false, fields: c.fields };
  return {
    valid: true,
    value: { kind: kind!, title: title!, dueOn: dueOn!, assigneeEmail: assigneeEmail ?? null, notes: notes ?? "" },
  };
}

export interface DeadlinePatch {
  kind?: GrantDeadlineKind;
  title?: string;
  dueOn?: string;
  assigneeEmail?: string | null;
  status?: GrantDeadlineStatus;
  notes?: string;
}

export function validateDeadlinePatch(body: unknown): Validation<DeadlinePatch> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const out: DeadlinePatch = {};
  const kind = oneOf<GrantDeadlineKind>(c, body, "kind", GRANT_DEADLINE_KINDS, false);
  if (kind !== undefined) out.kind = kind;
  if ("title" in body) {
    const title = text(c, body, "title", { required: true, max: 200 });
    if (typeof title === "string") out.title = title;
  }
  if ("dueOn" in body) {
    const dueOn = date(c, body, "dueOn", true);
    if (typeof dueOn === "string") out.dueOn = dueOn;
  }
  const assigneeEmail = email(c, body, "assigneeEmail");
  if (assigneeEmail !== undefined) out.assigneeEmail = assigneeEmail;
  const status = oneOf<GrantDeadlineStatus>(c, body, "status", GRANT_DEADLINE_STATUSES, false);
  if (status !== undefined) out.status = status;
  const notes = text(c, body, "notes", { required: false, max: 5000 });
  if (notes !== undefined) out.notes = notes ?? "";
  if (!c.ok) return { valid: false, fields: c.fields };
  return { valid: true, value: out };
}

export function parseDocumentKind(raw: string | null): GrantDocumentKind | null {
  const v = raw ?? "award_letter";
  return (GRANT_DOCUMENT_KINDS as readonly string[]).includes(v) ? (v as GrantDocumentKind) : null;
}

/** A filename safe to echo back and to put in a Content-Disposition header. */
export function sanitizeFilename(raw: string | null): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\w.\- ]+/g, "_").trim().slice(0, 120);
  return clean.length > 0 ? clean : "document";
}
