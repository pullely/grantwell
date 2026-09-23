"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { DueBadge } from "@/components/grants/due-badge";
import { wrap } from "@/lib/api";
import type {
  GetGrantResponse,
  GrantDeadlineKind,
  GrantDocumentKind,
  PublicGrantDeadline,
  PublicGrantDocument,
} from "@saas/contracts/grant";
import {
  GRANT_DEADLINE_KINDS,
  GRANT_DEADLINE_KIND_LABELS,
  GRANT_UPLOAD_CONTENT_TYPES,
  formatGrantAmount,
} from "@saas/contracts/grant";

export default function GrantPage() {
  const params = useParams<{ orgSlug: string; grantId: string }>();
  const slug = params?.orgSlug ?? "";
  const grantId = params?.grantId ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} grantId={grantId} />}</OrgScope>;
}

/** Download a file behind the bearer token (a plain <a href> would not carry it). */
function useAuthedDownload() {
  const { target, token } = useSession();
  return React.useCallback(
    async (path: string, filename: string) => {
      const res = await fetch(`${target.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!res.ok) return false;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return true;
    },
    [target, token],
  );
}

function Inner({ orgId, orgSlug, grantId }: { orgId: string; orgSlug: string; grantId: string }) {
  const { client } = useSession();
  const detail = useApiQuery(qk.grant(orgId, grantId), () => wrap(async () => client.grants.getGrant(orgId, grantId)));

  if (detail.loading) return <Skeleton className="h-40 w-full" />;
  if (detail.error || !detail.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">{detail.error?.code ?? "not_found"}</CardTitle>
          <CardDescription>{detail.error?.message ?? "Grant not found"}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <Detail orgId={orgId} orgSlug={orgSlug} grantId={grantId} data={detail.data} reload={detail.reload} />;
}

function Detail({
  orgId,
  orgSlug,
  grantId,
  data,
  reload,
}: {
  orgId: string;
  orgSlug: string;
  grantId: string;
  data: GetGrantResponse;
  reload: () => void;
}) {
  const { grant } = data;
  return (
    <div className="space-y-5">
      <header>
        <Link className="text-xs text-muted-foreground underline" href={`/orgs/${orgSlug}/grants`}>
          ← All grants
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{grant.title}</h1>
        <p className="text-sm text-muted-foreground">
          {grant.funderName} · {formatGrantAmount(grant.amountCents, grant.currency)} · {grant.periodStart ?? "—"} →{" "}
          {grant.periodEnd ?? "—"} · <Badge variant={grant.status === "active" ? "default" : "secondary"}>{grant.status}</Badge>
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">The award</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted-foreground">Program officer</div>
            {grant.funderContactName ?? "—"} {grant.funderContactEmail ? `· ${grant.funderContactEmail}` : ""}
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Grant lead (escalations)</div>
            {grant.leadEmail ?? "—"}
          </div>
          <div className="sm:col-span-2">
            <div className="text-xs text-muted-foreground">Restrictions</div>
            <p className="whitespace-pre-wrap">{grant.restrictions || "None recorded"}</p>
          </div>
        </CardContent>
      </Card>

      <Deadlines orgId={orgId} grantId={grantId} deadlines={data.deadlines} reload={reload} />
      <Documents orgId={orgId} grantId={grantId} documents={data.documents} reload={reload} />
    </div>
  );
}

function Deadlines({
  orgId,
  grantId,
  deadlines,
  reload,
}: {
  orgId: string;
  grantId: string;
  deadlines: PublicGrantDeadline[];
  reload: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [form, setForm] = React.useState({ kind: "narrative_report" as GrantDeadlineKind, title: "", dueOn: "", assigneeEmail: "" });
  const [busy, setBusy] = React.useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await wrap(async () =>
      client.grants.createDeadline(orgId, grantId, {
        kind: form.kind,
        title: form.title,
        dueOn: form.dueOn,
        assigneeEmail: form.assigneeEmail || null,
      }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not add the deadline", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Deadline added", description: form.assigneeEmail ? `${form.assigneeEmail} has been told.` : undefined });
    setForm({ kind: form.kind, title: "", dueOn: "", assigneeEmail: "" });
    reload();
  }

  async function setStatus(d: PublicGrantDeadline, status: "open" | "submitted" | "waived") {
    const r = await wrap(async () => client.grants.updateDeadline(orgId, grantId, d.id, { status }));
    if (!r.ok) {
      toast({ kind: "error", title: "Could not update the deadline", description: r.error.message });
      return;
    }
    const on = r.data.deadline.onTime;
    toast({
      kind: "success",
      title: status === "submitted" ? (on ? "Submitted on time" : "Submitted late") : `Marked ${status}`,
    });
    reload();
  }

  const field = "block text-sm font-medium mb-1";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Deadlines</CardTitle>
        <CardDescription>Every report and deliverable this award obliges, and who is responsible.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {deadlines.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>Due</TH>
                <TH>Deadline</TH>
                <TH>Responsible</TH>
                <TH>State</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {deadlines.map((d) => (
                <TR key={d.id}>
                  <TD className="whitespace-nowrap">
                    <div className="text-sm">{d.dueOn}</div>
                    {d.status === "open" && <DueBadge dueOn={d.dueOn} />}
                  </TD>
                  <TD>
                    <div className="font-medium">{d.title}</div>
                    <div className="text-xs text-muted-foreground">{GRANT_DEADLINE_KIND_LABELS[d.kind] ?? d.kind}</div>
                  </TD>
                  <TD className="text-sm">{d.assigneeEmail ?? <span className="text-muted-foreground">Unassigned</span>}</TD>
                  <TD>
                    {d.status === "submitted" ? (
                      <Badge variant={d.onTime ? "success" : "warning"}>{d.onTime ? "Submitted on time" : "Submitted late"}</Badge>
                    ) : d.status === "waived" ? (
                      <Badge variant="secondary">Waived</Badge>
                    ) : (
                      <Badge variant="default">Open</Badge>
                    )}
                  </TD>
                  <TD className="text-right">
                    {d.status === "open" ? (
                      <Button size="sm" variant="outline" onClick={() => void setStatus(d, "submitted")}>
                        Mark submitted
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => void setStatus(d, "open")}>
                        Reopen
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-5 sm:items-end">
          <div>
            <label className={field} htmlFor="d-kind">Kind</label>
            <select
              id="d-kind"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as GrantDeadlineKind }))}
            >
              {GRANT_DEADLINE_KINDS.map((k) => (
                <option key={k} value={k}>{GRANT_DEADLINE_KIND_LABELS[k]}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={field} htmlFor="d-title">Title</label>
            <Input id="d-title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
          </div>
          <div>
            <label className={field} htmlFor="d-due">Due</label>
            <Input id="d-due" type="date" value={form.dueOn} onChange={(e) => setForm((f) => ({ ...f, dueOn: e.target.value }))} required />
          </div>
          <div>
            <label className={field} htmlFor="d-who">Responsible (email)</label>
            <Input id="d-who" type="email" value={form.assigneeEmail} onChange={(e) => setForm((f) => ({ ...f, assigneeEmail: e.target.value }))} />
          </div>
          <div className="sm:col-span-5">
            <Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add deadline"}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Documents({
  orgId,
  grantId,
  documents,
  reload,
}: {
  orgId: string;
  grantId: string;
  documents: PublicGrantDocument[];
  reload: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const download = useAuthedDownload();
  const [kind, setKind] = React.useState<GrantDocumentKind>(documents.some((d) => d.kind === "award_letter") ? "report" : "award_letter");
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    const r = await wrap(async () =>
      client.grants.uploadDocument(orgId, grantId, file, { contentType: file.type || "application/pdf", filename: file.name, kind }),
    );
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    if (!r.ok) {
      toast({ kind: "error", title: "Upload failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: kind === "award_letter" ? "Award letter stored" : "Document stored" });
    reload();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Award letter and documents</CardTitle>
        <CardDescription>Stored privately; PDF, Word, PNG or JPEG up to 20 MB. Documents are never overwritten.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {documents.length > 0 && (
          <ul className="space-y-2 text-sm">
            {documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <Badge variant={d.kind === "award_letter" ? "default" : "secondary"}>{d.kind.replace("_", " ")}</Badge>
                <button
                  type="button"
                  className="underline"
                  onClick={() => void download(`/v1/organizations/${orgId}/grants/${grantId}/documents/${d.id}`, d.filename)}
                >
                  {d.filename}
                </button>
                <span className="text-xs text-muted-foreground">
                  {(d.byteSize / 1024).toFixed(0)} KB · {d.uploadedAt.slice(0, 10)} · sha256 {d.sha256.slice(0, 12)}…
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Document kind"
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as GrantDocumentKind)}
          >
            <option value="award_letter">Award letter</option>
            <option value="report">Report</option>
            <option value="other">Other</option>
          </select>
          <input
            ref={inputRef}
            type="file"
            accept={GRANT_UPLOAD_CONTENT_TYPES.join(",")}
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
            className="text-sm"
          />
          {busy && <span className="text-xs text-muted-foreground">Uploading…</span>}
        </div>
      </CardContent>
    </Card>
  );
}
