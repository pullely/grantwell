import { Badge } from "@/components/ui/badge";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Whole days from today (UTC) to a YYYY-MM-DD date; negative when past. */
export function daysUntil(dueOn: string, today = todayUtc()): number {
  return Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function DueBadge({ dueOn }: { dueOn: string }) {
  const days = daysUntil(dueOn);
  if (days < 0) return <Badge variant="destructive">{-days}d overdue</Badge>;
  if (days === 0) return <Badge variant="warning">Due today</Badge>;
  if (days <= 14) return <Badge variant="warning">In {days}d</Badge>;
  return <Badge variant="secondary">In {days}d</Badge>;
}
