import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * The Grantwell mark: a sprout: a stem with two leaves.
 *
 * Drawn on a 24×24 grid in `currentColor`, so it takes the colour of the
 * badge it sits in (`text-primary-foreground` on `bg-primary`).
 * `src/app/icon.svg` is the same mark with fixed colours, because a favicon
 * can't read CSS variables.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-5 w-5", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 21v-9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 14C12 10 9.5 7.5 5 7.5c0 4.2 2.8 6.5 7 6.5z" fill="currentColor" />
      <path d="M12 11.5c0-4.2 2.6-7 7-7 0 4.4-2.6 7-7 7z" fill="currentColor" />
    </svg>
  );
}
