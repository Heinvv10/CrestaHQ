"use client";

import { ArrowDownUp, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SELECT_CLASS } from "@/components/assignee-select";
import { cn } from "@/lib/utils";
import {
  INBOX_CHANNELS,
  type InboxFilters,
  type InboxTab,
} from "@/lib/conversations/inbox-filters";
import type { ConversationChannel } from "@/types/conversations";

const TAB_LABEL: Record<InboxTab, string> = {
  unread: "Unread",
  all: "All",
  starred: "Starred",
};

const CHANNEL_OPTION: Record<ConversationChannel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  "web-chat": "Web chat",
};

/**
 * Tabs (Unread with a count badge · All · Starred), inbox scope, channel and
 * last-direction filters, sort toggle and search. Controlled: the list pane
 * owns the state (URL query + local search).
 */
export function InboxToolbar({
  filters,
  counts,
  search,
  onFiltersChange,
  onSearchChange,
}: {
  filters: InboxFilters;
  counts: Record<InboxTab, number>;
  search: string;
  onFiltersChange: (next: InboxFilters) => void;
  onSearchChange: (value: string) => void;
}) {
  const set = (patch: Partial<InboxFilters>) =>
    onFiltersChange({ ...filters, ...patch });

  return (
    <div className="space-y-2">
      <div
        role="tablist"
        aria-label="Inbox tabs"
        className="flex gap-1 border-b"
      >
        {(["unread", "all", "starred"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={filters.tab === tab}
            onClick={() => set({ tab })}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              filters.tab === tab
                ? "border-primary text-primary"
                : "text-muted-foreground hover:text-foreground border-transparent"
            )}
          >
            {TAB_LABEL[tab]}
            {tab === "unread" && counts.unread > 0 && (
              <span
                data-testid="unread-tab-count"
                className="bg-primary text-primary-foreground rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
              >
                {counts.unread}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label="Inbox"
          value={filters.scope}
          onChange={(e) =>
            set({ scope: e.target.value as InboxFilters["scope"] })
          }
          className={SELECT_CLASS}
        >
          <option value="all">All conversations</option>
          <option value="mine">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </select>
        <select
          aria-label="Channel"
          value={filters.channel ?? ""}
          onChange={(e) =>
            set({
              channel: (e.target.value || null) as InboxFilters["channel"],
            })
          }
          className={SELECT_CLASS}
        >
          <option value="">All channels</option>
          {INBOX_CHANNELS.map((ch) => (
            <option key={ch} value={ch}>
              {CHANNEL_OPTION[ch]}
            </option>
          ))}
        </select>
        <select
          aria-label="Last message"
          value={filters.direction ?? ""}
          onChange={(e) =>
            set({
              direction: (e.target.value || null) as InboxFilters["direction"],
            })
          }
          className={SELECT_CLASS}
        >
          <option value="">Any last message</option>
          <option value="inbound">Awaiting reply (inbound)</option>
          <option value="outbound">Replied (outbound)</option>
        </select>
        <button
          type="button"
          aria-label="Sort"
          onClick={() =>
            set({ sort: filters.sort === "newest" ? "oldest" : "newest" })
          }
          className={cn(
            SELECT_CLASS,
            "hover:bg-muted items-center justify-center gap-1.5"
          )}
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
          {filters.sort === "newest" ? "Newest first" : "Oldest first"}
        </button>
      </div>

      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by name, phone or email"
          aria-label="Search conversations"
          className="pl-8"
        />
      </div>
    </div>
  );
}
