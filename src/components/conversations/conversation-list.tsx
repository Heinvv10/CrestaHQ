"use client";

import Link from "next/link";
import { useState } from "react";
import { MessagesSquare } from "lucide-react";
import { toDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RENDER_STEP, ShowMoreRows } from "@/components/show-more-rows";
import { StarToggle } from "@/components/conversations/star-toggle";
import type { ConversationDoc, ConversationChannel } from "@/types/conversations";

const CHANNEL_LABEL: Record<ConversationChannel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  "web-chat": "Web Chat",
};

const CHANNEL_BADGE: Record<ConversationChannel, string> = {
  email: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  sms: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  whatsapp: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  messenger: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  instagram: "bg-pink-500/10 text-pink-700 dark:text-pink-400",
  "web-chat": "bg-sky-500/10 text-sky-700 dark:text-sky-400",
};

export function ConversationList({
  conversations,
  basePath,
  query = "",
  activeId = null,
  filtered = false,
}: {
  /** Pre-filtered + pre-sorted by the page. */
  conversations: ConversationDoc[];
  /** e.g. `/sa/{id}/conversations` — rows link to `{basePath}/{conversationId}`
   *  (the conversation doc id: contactId for most channels, the session key
   *  for web chat). */
  basePath: string;
  /** Inbox filter query carried onto every row link, so opening a thread
   *  keeps the list's tab/scope/filters. */
  query?: string;
  /** The open thread's id — its row is highlighted. */
  activeId?: string | null;
  /** True when filters (not an empty inbox) produced zero rows. */
  filtered?: boolean;
}) {
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);

  if (conversations.length === 0 && filtered) {
    return (
      <p className="rounded-xl border border-dashed bg-card/50 p-8 text-center text-sm text-muted-foreground">
        No conversations match these filters.
      </p>
    );
  }
  if (conversations.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-card/50 p-12 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <MessagesSquare className="h-6 w-6 text-primary" />
        </div>
        <h3 className="text-base font-semibold">No conversations yet</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Inbound and outbound email, SMS, WhatsApp, and web chat messages land here.
          Send a message or wait for a customer to reply.
        </p>
      </div>
    );
  }

  // Always render through the open thread's row, so a deep-linked thread
  // that sorts past the cap still shows (and highlights) in the list.
  const activeIndex = conversations.findIndex((c) => c.id === activeId);
  const shown = conversations.slice(0, Math.max(renderLimit, activeIndex + 1));

  return (
    <>
      <div className="divide-y overflow-hidden rounded-xl border bg-card">
        {shown.map((c) => {
          const unread = (c.unreadCount ?? 0) > 0;
          const ts = toDate(c.lastMessageAt);
          const title = c.contactName || c.contactPhone || "Unknown contact";
          const active = c.id === activeId;
          return (
            <div
              key={c.id}
              data-testid="conversation-row"
              className={cn(
                "flex items-center transition-colors hover:bg-muted/50",
                active && "bg-muted",
              )}
            >
              <Link
                href={`${basePath}/${c.id}${query ? `?${query}` : ""}`}
                aria-current={active ? "page" : undefined}
                className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 pl-4"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {initials(title)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        "truncate text-sm",
                        unread ? "font-semibold" : "font-medium",
                      )}
                    >
                      {title}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {ts ? formatShort(ts) : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        "truncate text-xs",
                        unread ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {c.lastDirection === "outbound" ? "You: " : ""}
                      {c.lastMessagePreview}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {c.pendingDraft && (
                        <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                          Draft
                        </span>
                      )}
                      <span
                        className={cn(
                          "rounded-full px-1.5 text-[10px] font-medium",
                          CHANNEL_BADGE[c.lastChannel] ?? CHANNEL_BADGE.sms,
                        )}
                      >
                        {CHANNEL_LABEL[c.lastChannel] ?? c.lastChannel}
                      </span>
                      {c.lateButtonTap && (
                        <span
                          title={`Tapped "${c.lateButtonTap.text}" after the workflow stopped waiting — no automation will answer it. Clears when you reply.`}
                          className="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-400"
                        >
                          Late tap
                        </span>
                      )}
                      {unread && (
                        <span
                          data-testid="row-unread"
                          className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary-foreground"
                        >
                          {c.unreadCount}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </Link>
              <StarToggle
                conversationId={c.id}
                starred={c.starred === true}
                className="mr-3 shrink-0"
              />
            </div>
          );
        })}
      </div>
      <ShowMoreRows
        shown={shown.length}
        total={conversations.length}
        onMore={() => setRenderLimit(shown.length + RENDER_STEP)}
      />
    </>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatShort(d: Date): string {
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 24 * 3600 * 1000) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
