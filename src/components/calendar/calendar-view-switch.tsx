"use client";

import Link from "next/link";
import { useSubAccount } from "@/context/sub-account-context";
import { cn } from "@/lib/utils";

/**
 * Two-way "Calendar / Appointments" switch shown atop both views (SP3 f) —
 * each a real route (not tab state), so the URL, back button, and deep
 * links all work.
 */
export function CalendarViewSwitch({
  active,
}: {
  active: "calendar" | "appointments";
}) {
  const { saPath } = useSubAccount();
  const tabs: { key: "calendar" | "appointments"; label: string; href: string }[] = [
    { key: "calendar", label: "Calendar", href: saPath("/calendar") },
    { key: "appointments", label: "Appointments", href: saPath("/calendar/appointments") },
  ];
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition",
            active === tab.key
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
