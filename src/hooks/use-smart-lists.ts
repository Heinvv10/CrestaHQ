"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createSmartList,
  deleteSmartList,
  renameSmartList,
  subscribeToSmartLists,
} from "@/lib/firestore/smart-lists";
import { EMPTY_FILTERS } from "@/lib/contacts/filter";
import type { SmartListDoc } from "@/types/contacts";
import type { ConditionGroup } from "@/types/workflows";

/**
 * Smart-list state for the contacts page: the live list of saved lists, the
 * filter group in the panel, and which tab is selected. The selected tab is
 * owned by the URL (`?list=<id>`) — `selectList` only navigates, and the
 * page feeds the param back through `setActiveListId` — so a tab is
 * deep-linkable and there is exactly one path that loads a list's filters.
 */
export function useSmartLists({
  agencyId,
  subAccountId,
  uid,
}: {
  agencyId: string | null | undefined;
  subAccountId: string;
  uid: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [filters, setFilters] = useState<ConditionGroup>(EMPTY_FILTERS);
  const [lists, setLists] = useState<SmartListDoc[] | null>(null);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  // Read by the tab-change effect without re-running it on every snapshot —
  // a rename elsewhere must not clobber filters being edited here.
  const listsRef = useRef<SmartListDoc[]>([]);

  const selectList = useCallback(
    (id: string | null) =>
      router.replace(id ? `${pathname}?list=${id}` : pathname),
    [router, pathname],
  );

  useEffect(() => {
    if (!subAccountId) return;
    const unsub = subscribeToSmartLists(
      subAccountId,
      (l) => {
        listsRef.current = l;
        setLists(l);
      },
      // Mark the lists as loaded (empty) so a ?list= deep link falls back to
      // All instead of leaving the page waiting on a stream that has died.
      () => {
        toast.error("Couldn't load smart lists.");
        listsRef.current = [];
        setLists([]);
      },
    );
    return () => unsub();
  }, [subAccountId]);

  // Selecting a tab loads its filters into the panel. A stale ?list= id (a
  // deleted list) falls back to All.
  const listsLoaded = lists !== null;
  useEffect(() => {
    if (!listsLoaded) return;
    if (activeListId === null) {
      setFilters(EMPTY_FILTERS);
      return;
    }
    const list = listsRef.current.find((l) => l.id === activeListId);
    if (list) setFilters(list.filters);
    else selectList(null);
  }, [activeListId, listsLoaded, selectList]);

  // Each action resolves true on success so the dialog closes only when the
  // write actually happened; a failure toasts and leaves the dialog open.
  async function saveList(name: string): Promise<boolean> {
    if (!agencyId || !uid) {
      toast.error("Could not save the list.");
      return false;
    }
    try {
      const id = await createSmartList(
        { agencyId, subAccountId },
        uid,
        name,
        filters,
      );
      toast.success(`Saved “${name}”`);
      selectList(id);
      return true;
    } catch {
      toast.error("Could not save the list.");
      return false;
    }
  }
  async function renameList(id: string, name: string): Promise<boolean> {
    try {
      await renameSmartList(subAccountId, id, name);
      return true;
    } catch {
      toast.error("Could not rename the list.");
      return false;
    }
  }
  async function deleteList(id: string): Promise<boolean> {
    try {
      await deleteSmartList(subAccountId, id);
      selectList(null);
      return true;
    } catch {
      toast.error("Could not delete the list.");
      return false;
    }
  }

  return {
    filters,
    setFilters,
    lists: lists ?? [],
    activeListId,
    setActiveListId,
    selectList,
    saveList,
    renameList,
    deleteList,
  };
}
