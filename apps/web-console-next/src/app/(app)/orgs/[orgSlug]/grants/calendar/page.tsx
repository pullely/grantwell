"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { daysUntil } from "@/components/grants/due-badge";
import type { PublicGrantDeadlineWithGrant } from "@saas/contracts/grant";
import { GRANT_DEADLINE_KIND_LABELS } from "@saas/contracts/grant";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The month's cells, Monday first, padded with nulls to whole weeks. */
function monthCells(month: string): (string | null)[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function tone(d: PublicGrantDeadlineWithGrant): string {
  if (d.status === "submitted") return d.onTime ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/40 bg-amber-500/10";
  if (d.status === "waived") return "border-muted bg-muted text-muted-foreground line-through";
  return daysUntil(d.dueOn) < 0 ? "border-destructive/50 bg-destructive/10" : "border-primary/30 bg-primary/5";
}

export default function GrantCalendarPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const [month, setMonth] = React.useState(currentMonth);
  const calendar = useApiQuery(qk.grantCalendar(orgId, month), () =>
    wrap(async () => (await client.grants.deadlineCalendar(orgId, month)).deadlines),
  );
  const byDay = React.useMemo(() => {
    const map = new Map<string, PublicGrantDeadlineWithGrant[]>();
    for (const d of calendar.data ?? []) map.set(d.dueOn, [...(map.get(d.dueOn) ?? []), d]);
    return map;
  }, [calendar.data]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Obligations calendar</h1>
          <p className="text-sm text-muted-foreground">
            Every report and deliverable due this month, across all grants. Reminders go out at 30, 14, 7, 1 and 0 days, and
            the grant lead is copied from one day out.
          </p>
        </div>
        <Link className="text-sm underline" href={`/orgs/${orgSlug}/grants`}>
          Back to grants
        </Link>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">{monthLabel(month)}</CardTitle>
            <CardDescription>
              {calendar.data ? `${calendar.data.length} deadline${calendar.data.length === 1 ? "" : "s"}` : " "}
            </CardDescription>
          </div>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setMonth(currentMonth())}>
              Today
            </Button>
            <Button variant="outline" size="sm" aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {calendar.loading ? (
            <Skeleton className="h-64 w-full" />
          ) : calendar.error ? (
            <p className="text-sm text-destructive">{calendar.error.message}</p>
          ) : (
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border bg-border text-xs">
              {WEEKDAYS.map((w) => (
                <div key={w} className="bg-muted px-2 py-1 font-medium text-muted-foreground">
                  {w}
                </div>
              ))}
              {monthCells(month).map((day, i) => (
                <div key={day ?? `pad-${i}`} className={`min-h-24 bg-background p-1.5 ${day === today ? "ring-1 ring-inset ring-primary" : ""}`}>
                  {day && (
                    <>
                      <div className="mb-1 text-muted-foreground">{Number(day.slice(8))}</div>
                      <ul className="space-y-1">
                        {(byDay.get(day) ?? []).map((d) => (
                          <li key={d.id}>
                            <Link
                              href={`/orgs/${orgSlug}/grants/${d.grantId}`}
                              className={`block rounded border px-1.5 py-1 leading-tight hover:underline ${tone(d)}`}
                              title={`${d.title} — ${d.grantTitle} (${d.funderName})${d.assigneeEmail ? ` · ${d.assigneeEmail}` : ""}`}
                            >
                              <span className="font-medium">{d.title}</span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {GRANT_DEADLINE_KIND_LABELS[d.kind] ?? d.kind} · {d.grantTitle}
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
