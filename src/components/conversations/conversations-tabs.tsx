"use client";

import Link from "next/link";
import { useSubAccount } from "@/context/sub-account-context";
import { cn } from "@/lib/utils";

/** Top tabs of the Conversations area (GHL: Conversations · Snippets). */
export function ConversationsTabs({
  active,
}: {
  active: "inbox" | "snippets";
}) {
  const { saPath } = useSubAccount();
  const tabs = [
    { key: "inbox", label: "Conversations", href: saPath("/conversations") },
    {
      key: "snippets",
      label: "Snippets",
      href: saPath("/conversations/snippets"),
    },
  ] as const;
  return (
    <nav
      aria-label="Conversations sections"
      className="flex gap-4 border-b text-sm"
    >
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-1 pb-2 font-medium transition-colors",
            active === t.key
              ? "border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground border-transparent"
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
