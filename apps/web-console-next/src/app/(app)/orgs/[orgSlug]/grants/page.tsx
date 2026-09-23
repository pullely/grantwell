"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { HandCoins } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { DueBadge } from "@/components/grants/due-badge";
import { wrap } from "@/lib/api";
import type { CreateGrantRequest, PublicGrant, PublicGrantDeadlineWithGrant } from "@saas/contracts/grant";
import { GRANT_DEADLINE_KIND_LABELS, formatGrantAmount } from "@saas/contracts/grant";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  active: "default",
  closed: "secondary",
  declined: "destructive",
};

export default function GrantsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const grants = useApiQuery(qk.grants(orgId), () => wrap(async () => (await client.grants.listGrants(orgId)).grants));
  const deadlines = useApiQuery(qk.grantDeadlines(orgId), () =>
    wrap(async () => (await client.grants.listDeadlines(orgId, { status: "open" })).deadlines),
  );
  const [creating, setCreating] = React.useState(false);

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Grants</h1>
          <p className="text-sm text-muted-foreground">
            Every grant, its award letter, and every report and deliverable it obliges — with the person responsible.
          </p>
        </div>
        {!creating && <Button onClick={() => setCreating(true)}>New grant</Button>}
      </header>

      {creating && (
        <GrantForm
          orgId={orgId}
          onDone={() => {
            setCreating(false);
            grants.reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upcoming deadlines</CardTitle>
          <CardDescription>Open reports and deliverables across every grant, soonest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {deadlines.loading ? (
            <Skeleton className="h-16 w-full" />
          ) : deadlines.error ? (
            <p className="text-sm text-destructive">{deadlines.error.message}</p>
          ) : (deadlines.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing open. Add deadlines on a grant&apos;s page.</p>
          ) : (
            <DeadlinesTable orgSlug={orgSlug} deadlines={deadlines.data ?? []} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All grants</CardTitle>
        </CardHeader>
        <CardContent>
          {grants.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : grants.error ? (
            <p className="text-sm text-destructive">{grants.error.message}</p>
          ) : (grants.data ?? []).length === 0 ? (
            <div className="flex flex-col items-center py-10 text-center text-sm text-muted-foreground">
              <HandCoins className="h-8 w-8 mb-3 text-primary" />
              No grants yet. Record your first award to start tracking its obligations.
            </div>
          ) : (
            <GrantsTable orgSlug={orgSlug} grants={grants.data ?? []} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DeadlinesTable({ orgSlug, deadlines }: { orgSlug: string; deadlines: PublicGrantDeadlineWithGrant[] }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Due</TH>
          <TH>Deadline</TH>
          <TH>Grant</TH>
          <TH>Responsible</TH>
        </TR>
      </THead>
      <TBody>
        {deadlines.map((d) => (
          <TR key={d.id}>
            <TD className="whitespace-nowrap">
              <div className="text-sm">{d.dueOn}</div>
              <DueBadge dueOn={d.dueOn} />
            </TD>
            <TD>
              <div className="font-medium">{d.title}</div>
              <div className="text-xs text-muted-foreground">{GRANT_DEADLINE_KIND_LABELS[d.kind] ?? d.kind}</div>
            </TD>
            <TD>
              <Link className="underline" href={`/orgs/${orgSlug}/grants/${d.grantId}`}>
                {d.grantTitle}
              </Link>
              <div className="text-xs text-muted-foreground">{d.funderName}</div>
            </TD>
            <TD className="text-sm">{d.assigneeEmail ?? <span className="text-muted-foreground">Unassigned</span>}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function GrantsTable({ orgSlug, grants }: { orgSlug: string; grants: PublicGrant[] }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Grant</TH>
          <TH>Amount</TH>
          <TH>Period</TH>
          <TH>Next deadline</TH>
          <TH>Status</TH>
        </TR>
      </THead>
      <TBody>
        {grants.map((g) => (
          <TR key={g.id}>
            <TD>
              <Link className="font-medium underline" href={`/orgs/${orgSlug}/grants/${g.id}`}>
                {g.title}
              </Link>
              <div className="text-xs text-muted-foreground">{g.funderName}</div>
            </TD>
            <TD className="text-sm">{formatGrantAmount(g.amountCents, g.currency)}</TD>
            <TD className="text-xs text-muted-foreground">
              {g.periodStart ?? "—"} → {g.periodEnd ?? "—"}
            </TD>
            <TD>
              {g.nextDeadline ? (
                <div className="text-sm">
                  {g.nextDeadline.title} <span className="text-muted-foreground">· {g.nextDeadline.dueOn}</span>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">None open</span>
              )}
            </TD>
            <TD>
              <Badge variant={STATUS_VARIANT[g.status] ?? "secondary"}>{g.status}</Badge>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function GrantForm({ orgId, onDone, onCancel }: { orgId: string; onDone: () => void; onCancel: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [form, setForm] = React.useState({
    title: "",
    funderName: "",
    funderContactName: "",
    funderContactEmail: "",
    amount: "",
    periodStart: "",
    periodEnd: "",
    restrictions: "",
    leadEmail: "",
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const amount = form.amount.trim() === "" ? null : Math.round(Number(form.amount.replace(/[$,]/g, "")) * 100);
    if (amount !== null && !Number.isFinite(amount)) {
      toast({ kind: "error", title: "The amount is not a number" });
      return;
    }
    const body: CreateGrantRequest = {
      title: form.title,
      funderName: form.funderName,
      funderContactName: form.funderContactName || null,
      funderContactEmail: form.funderContactEmail || null,
      amountCents: amount,
      periodStart: form.periodStart || null,
      periodEnd: form.periodEnd || null,
      restrictions: form.restrictions,
      leadEmail: form.leadEmail || null,
    };
    setBusy(true);
    const r = await wrap(async () => (await client.grants.createGrant(orgId, body)).grant);
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not save the grant", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Grant recorded", description: "Now add its deadlines and upload the award letter." });
    onDone();
  }

  const field = "block text-sm font-medium mt-3 mb-1";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New grant</CardTitle>
        <CardDescription>What the award letter says. Deadlines and the letter itself go on the grant&apos;s page.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid max-w-2xl gap-x-4 sm:grid-cols-2">
          <div>
            <label className={field} htmlFor="g-title">Grant title</label>
            <Input id="g-title" value={form.title} onChange={(e) => set("title", e.target.value)} required />
          </div>
          <div>
            <label className={field} htmlFor="g-funder">Funder</label>
            <Input id="g-funder" value={form.funderName} onChange={(e) => set("funderName", e.target.value)} required />
          </div>
          <div>
            <label className={field} htmlFor="g-amount">Amount (USD)</label>
            <Input id="g-amount" inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} placeholder="25,000" />
          </div>
          <div>
            <label className={field} htmlFor="g-lead">Grant lead email (escalations)</label>
            <Input id="g-lead" type="email" value={form.leadEmail} onChange={(e) => set("leadEmail", e.target.value)} />
          </div>
          <div>
            <label className={field} htmlFor="g-start">Period start</label>
            <Input id="g-start" type="date" value={form.periodStart} onChange={(e) => set("periodStart", e.target.value)} />
          </div>
          <div>
            <label className={field} htmlFor="g-end">Period end</label>
            <Input id="g-end" type="date" value={form.periodEnd} onChange={(e) => set("periodEnd", e.target.value)} />
          </div>
          <div>
            <label className={field} htmlFor="g-po">Program officer</label>
            <Input id="g-po" value={form.funderContactName} onChange={(e) => set("funderContactName", e.target.value)} />
          </div>
          <div>
            <label className={field} htmlFor="g-po-email">Program officer email</label>
            <Input id="g-po-email" type="email" value={form.funderContactEmail} onChange={(e) => set("funderContactEmail", e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className={field} htmlFor="g-restrictions">Restrictions</label>
            <Textarea id="g-restrictions" rows={3} value={form.restrictions} onChange={(e) => set("restrictions", e.target.value)} />
          </div>
          <div className="mt-5 flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save grant"}</Button>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
