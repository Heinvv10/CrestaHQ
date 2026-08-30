"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  GitBranch,
  Home,
  Menu,
  MessagesSquare,
  Users,
} from "lucide-react";
import { useUnreadConversationsCount } from "@/hooks/use-unread-conversations";
import { cn } from "@/lib/utils";

/**
 * Phone-only bottom tab bar (native-feel v1.2). Thumb-reach navigation for
 * the core loop — Dashboard, Conversations (unread badge), Contacts,
 * Pipeline — plus "More", which opens the existing sidebar drawer for the
 * long tail. Renders only inside a sub-account (/sa/[id]/…): agency-level
 * pages keep the drawer alone. Hidden at md+ where the sidebar is
 * permanent.
 *
 * The pb-[env(safe-area-inset-bottom)] keeps the bar above the iPhone home
 * indicator when running installed (standalone).
 */

const TABS = [
  { path: "/dashboard", label: "Home", icon: Home },
  { path: "/conversations", label: "Inbox", icon: MessagesSquare, badge: true },
  { path: "/contacts", label: "Contacts", icon: Users },
  { path: "/pipeline", label: "Pipeline", icon: GitBranch },
] as const;

export function BottomTabBar({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  // The bar only renders inside a sub-account, so derive the id straight from
  // the URL and feed it to the unread hook (which no longer reads context).
  const activeSubId = pathname.match(/^\/sa\/([^/]+)/)?.[1] ?? null;
  const unread = useUnreadConversationsCount(activeSubId);

  if (!activeSubId) return null;
  const subRoot = `/sa/${activeSubId}`;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <div className="flex h-14 items-stretch">
        {TABS.map((tab) => {
          const href = `${subRoot}${tab.path}`;
          const active =
            tab.path === "/dashboard"
              ? pathname === href || pathname.startsWith(`${href}/`)
              : pathname.startsWith(href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.path}
              href={href}
              className={cn(
                "relative flex min-w-0 flex-1 select-none flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors active:opacity-60",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <span className="relative">
                <Icon className="h-5 w-5" />
                {"badge" in tab && tab.badge && unread > 0 && (
                  <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold tabular-nums text-primary-foreground">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </span>
              {tab.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onMore}
          className="flex min-w-0 flex-1 select-none flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-muted-foreground transition-colors active:opacity-60"
        >
          <Menu className="h-5 w-5" />
          More
        </button>
      </div>
    </nav>
  );
}
