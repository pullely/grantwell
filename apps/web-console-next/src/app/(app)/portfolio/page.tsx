"use client";

import * as React from "react";
import Link from "next/link";
import { Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { DueBadge } from "@/components/grants/due-badge";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { GRANT_DEADLINE_KIND_LABELS, type GrantPortfolioResponse } from "@saas/contracts/grant";

function rate(r: number | null): string {
  return r === null ? "—" : `${Math.round(r * 100)}%`;
}

/**
 * The grant writer's portfolio (GW3): every organization the signed-in user
 * belongs to, with its next deadline, overdue count and on-time rate, and every
 * open deadline across them due in the next 30 days.
 */
export default function PortfolioPage() {
  const { client } = useSession();
  const { toast } = useToast();
  const portfolio = useApiQuery(qk.grantPortfolio(), () => wrap(async () => client.grants.portfolio()));
  const [sending, setSending] = React.useState(false);

  async function sendDigest() {
    setSending(true);
    const r = await wrap(async () => client.grants.sendMyDigest());
    setSending(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not send the digest", description: r.error.message });
    } else if (r.data.sent) {
      toast({ kind: "success", title: "Digest sent", description: `This week's digest (week of ${r.data.weekOf}) is on its way.` });
    } else {
      const why =
        r.data.reason === "already_sent"
          ? "This week's digest has already been sent."
          : r.data.reason === "nothing_open"
            ? "Nothing is open across your organizations."
            : "The digest is for members of two or more organizations.";
      toast({ kind: "default", title: "No digest sent", description: why });
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Portfolio</h1>
          <p className="text-sm text-muted-foreground">
            Every organization you work with, and what is due across them. Members of two or more organizations get this as an
            email every Monday.
          </p>
        </div>
        <Button variant="outline" onClick={sendDigest} disabled={sending}>
          {sending ? "Sending…" : "Email me this week's digest"}
        </Button>
      </header>

      {portfolio.loading ? (
        <Skeleton className="h-48 w-full" />
      ) : portfolio.error ? (
        <p className="text-sm text-destructive">{portfolio.error.message}</p>
      ) : !portfolio.data || portfolio.data.organizations.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center text-sm text-muted-foreground">
          <Briefcase className="mb-3 h-8 w-8 text-primary" />
          You are not a member of any organization yet. Ask a nonprofit to invite you, or create one.
        </div>
      ) : (
        <Body data={portfolio.data} />
      )}
    </div>
  );
}

function Body({ data }: { data: GrantPortfolioResponse }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organizations</CardTitle>
          <CardDescription>
            {data.organizations.length} organization{data.organizations.length === 1 ? "" : "s"} · {data.totals.open} open ·{" "}
            {data.totals.overdue} overdue · on-time rate {rate(data.totals.onTimeRate)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Organization</TH>
                <TH>Next deadline</TH>
                <TH>Open</TH>
                <TH>Overdue</TH>
                <TH>On-time rate</TH>
              </TR>
            </THead>
            <TBody>
              {data.organizations.map((o) => (
                <TR key={o.org.id}>
                  <TD>
                    <Link className="font-medium underline" href={`/orgs/${o.org.slug}/grants`}>
                      {o.org.name}
                    </Link>
                  </TD>
                  <TD>
                    {o.nextDeadline ? (
                      <Link className="text-sm hover:underline" href={`/orgs/${o.org.slug}/grants/${o.nextDeadline.grantId}`}>
                        {o.nextDeadline.title} <span className="text-muted-foreground">· {o.nextDeadline.dueOn}</span>
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">None open</span>
                    )}
                  </TD>
                  <TD className="tabular-nums">{o.stats.open}</TD>
                  <TD className={`tabular-nums ${o.stats.overdue > 0 ? "font-semibold text-destructive" : ""}`}>{o.stats.overdue}</TD>
                  <TD className="tabular-nums">{rate(o.stats.onTimeRate)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {data.truncated && (
            <p className="mt-2 text-xs text-muted-foreground">Showing the first {data.organizations.length} organizations.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Due in the next 30 days</CardTitle>
          <CardDescription>Open deadlines across every organization, overdue first.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.deadlines.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing due in the next 30 days.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Due</TH>
                  <TH>Deadline</TH>
                  <TH>Organization · grant</TH>
                  <TH>Responsible</TH>
                </TR>
              </THead>
              <TBody>
                {data.deadlines.map((d) => (
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
                      <Link className="underline" href={`/orgs/${d.orgSlug}/grants/${d.grantId}`}>
                        {d.orgName}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {d.grantTitle} · {d.funderName}
                      </div>
                    </TD>
                    <TD className="text-sm">{d.assigneeEmail ?? <span className="text-muted-foreground">Unassigned</span>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
