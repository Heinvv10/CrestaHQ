"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { useSubAccountConversations } from "@/context/conversations-context";
import { useConversationsPreview } from "@/hooks/use-conversations-preview";
import { useLoadingHint } from "@/hooks/use-loading-hint";
import { RENDER_STEP } from "@/components/show-more-rows";
import {
  DEFAULT_INBOX_FILTERS,
  buildInboxView,
  inboxFiltersToQuery,
  parseInboxFilters,
  planQueryWrite,
  reconcileUrlQuery,
  type InboxFilters,
} from "@/lib/conversations/inbox-filters";
import { ConversationList } from "@/components/conversations/conversation-list";
import { InboxToolbar } from "@/components/conversations/inbox-toolbar";
import type { ConversationDoc } from "@/types/conversations";

/**
 * Left pane of the Conversations workspace. Lives in the conversations
 * layout, so it stays mounted while threads open and close beside it; the
 * live list itself is held by ConversationsProvider across visits. Tab / scope / filters / sort live in the URL
 * query; the search box is local state (the layout keeps it across threads).
 */
export function InboxListPane() {
  const { user } = useAuth();
  const { subAccountId, saPath } = useSubAccount();
  const territory = useEffectiveTerritoryFilter();
  const params = useParams<{ contactId?: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Shared with the sub-account layout, so a revisit renders the list the
  // listener already holds instead of re-downloading it.
  const { conversations, loading, error } = useSubAccountConversations();
  const loadError = error
    ? "Could not load conversations. Check your access and try again."
    : null;
  const [search, setSearch] = useState("");
  // Local state is the source of truth, seeded from the URL, mirrored back to
  // it on every change, and re-synced when the URL changes from outside. Deriving filters from useSearchParams alone
  // raced: a second change made before router.replace landed was built on the
  // stale query and silently reverted the first.
  const [filters, setFilterState] = useState<InboxFilters>(() =>
    parseInboxFilters(searchParams)
  );
  const query = inboxFiltersToQuery(filters);
  // Queries this pane wrote that the URL has not echoed yet — see
  // reconcileUrlQuery. Lets a navigation from outside (sidebar link,
  // notification) reset the filters without a late echo undoing a newer
  // change made here.
  const pendingWrites = useRef<string[]>([]);
  useEffect(() => {
    const urlFilters = parseInboxFilters(searchParams);
    const decision = reconcileUrlQuery(
      inboxFiltersToQuery(urlFilters),
      pendingWrites.current
    );
    pendingWrites.current = decision.pending;
    if (decision.adopt) setFilterState(urlFilters);
  }, [searchParams]);

  // Newest page while the full list loads — only when it is exactly what the
  // list will show: no territory narrowing, filters, non-default sort or search.
  const preview = useConversationsPreview(
    subAccountId,
    RENDER_STEP,
    loading &&
      territory.ready &&
      !!user &&
      !territory.filter &&
      query === "" &&
      !search.trim()
  );

  const activeId = params.contactId ?? null;
  const view = useMemo(
    () =>
      buildInboxView(
        conversations,
        filters,
        user?.uid ?? null,
        search,
        activeId
      ),
    [conversations, filters, user?.uid, search, activeId]
  );

  function setFilters(next: InboxFilters) {
    setFilterState(next);
    const qs = inboxFiltersToQuery(next);
    const plan = planQueryWrite(
      qs,
      inboxFiltersToQuery(parseInboxFilters(searchParams)),
      pendingWrites.current
    );
    if (!plan.write) return;
    pendingWrites.current = plan.pending;
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Sort order is not a filter: an empty inbox sorted oldest-first is still
  // "no conversations yet", not "nothing matches".
  const filtered =
    inboxFiltersToQuery({ ...filters, sort: DEFAULT_INBOX_FILTERS.sort }) !==
      "" || !!search.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <h1 className="text-2xl font-bold tracking-tight">Conversations</h1>
      <InboxToolbar
        filters={filters}
        counts={view.counts}
        search={search}
        onFiltersChange={setFilters}
        onSearchChange={setSearch}
      />
      {loadError && <p className="text-destructive text-sm">{loadError}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading || !territory.ready ? (
          <InboxLoading
            key={`${subAccountId}|${territory.filter}`}
            preview={preview}
            basePath={saPath("/conversations")}
            query={query}
            activeId={activeId}
          />
        ) : (
          <ConversationList
            conversations={view.rows}
            basePath={saPath("/conversations")}
            query={query}
            activeId={activeId}
            filtered={filtered}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Loading state: the newest page once it lands, otherwise the skeleton. The
 * full list waits for the server (never a partial cache shown as complete),
 * so while offline or stalled this says why instead of loading silently.
 * The pane keys it per load, so the slow timer measures the current one.
 */
function InboxLoading({
  preview,
  basePath,
  query,
  activeId,
}: {
  preview: ConversationDoc[] | null;
  basePath: string;
  query: string;
  activeId: string | null;
}) {
  const hint = useLoadingHint();
  return (
    <div className="flex flex-col gap-3">
      {hint && (
        <p
          role="status"
          className="bg-muted/40 text-muted-foreground rounded-lg border px-3 py-2 text-sm"
        >
          {hint === "offline"
            ? "You're offline. Conversations will load when your connection is back."
            : "Still loading conversations — this is taking longer than usual. If it doesn't finish, reload the page."}
        </p>
      )}
      {preview?.length ? (
        <>
          <ConversationList
            conversations={preview}
            basePath={basePath}
            query={query}
            activeId={activeId}
          />
          <p className="text-muted-foreground py-3 text-center text-xs">
            Loading all conversations…
          </p>
        </>
      ) : (
        <ListSkeleton />
      )}
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="bg-card divide-y overflow-hidden rounded-xl border">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="bg-muted h-9 w-9 animate-pulse rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="bg-muted h-3 w-40 animate-pulse rounded" />
            <div className="bg-muted h-3 w-56 animate-pulse rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
