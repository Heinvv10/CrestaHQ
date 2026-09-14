"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSubAccount } from "@/context/sub-account-context";
import { cn } from "@/lib/utils";

/** The Reputation area's tabs, rendered once by the layout. A later SP5 PR adds Insights. */
const TABS = [
  { slug: "", label: "Overview" },
  { slug: "reviews", label: "Reviews" },
  { slug: "requests", label: "Requests" },
  { slug: "widgets", label: "Widgets" },
  { slug: "settings", label: "Settings" },
] as const;

export function ReputationTabs() {
  const pathname = usePathname();
  const { subAccountId } = useSubAccount();
  const base = `/sa/${subAccountId}/reputation`;
  return (
    <nav className="flex items-center overflow-x-auto border-b" data-testid="rep-tabs">
      {TABS.map((t) => {
        const href = t.slug ? `${base}/${t.slug}` : base;
        const active = t.slug ? pathname.startsWith(href) : pathname === base;
        return (
          <Link
            key={t.label}
            href={href}
            data-testid={`rep-tab-${t.slug || "overview"}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-4 py-3 text-sm transition-colors",
              active ? "border-amber-500 font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
