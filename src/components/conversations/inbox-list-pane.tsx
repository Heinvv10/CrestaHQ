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
import { subscribeToConversations } from "@/lib/firestore/conversations";
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
 * layout, so it stays mounted (and keeps its live subscription) while threads
 * open and close beside it. Tab / scope / filters / sort live in the URL
 * query; the search box is local state (the layout keeps it across threads).
 */
export function InboxListPane() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, saPath } = useSubAccount();
  const territory = useEffectiveTerritoryFilter();
  const params = useParams<{ contactId?: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [conversations, setConversations] = useState<ConversationDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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

  useEffect(() => {
    if (authLoading || !user || !subAccountId || !territory.ready) {
      setConversations([]);
      return;
    }
    setLoading(true);
    setConversations([]);
    setLoadError(null);
    const unsub = subscribeToConversations(
      subAccountId,
      (list) => {
        setConversations(list);
        setLoading(false);
      },
      () => {
        setConversations([]);
        setLoading(false);
        setLoadError(
          "Could not load conversations. Check your access and try again."
        );
      },
      territory.filter
    );
    return () => unsub();
  }, [user, subAccountId, authLoading, territory.ready, territory.filter]);

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
          <ListSkeleton />
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
