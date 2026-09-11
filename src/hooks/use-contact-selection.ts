"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Row selection for the contacts list, scoped to the VISIBLE ids (the
 * search + smart-list result). Select-all selects those and nothing else;
 * when the visible set shrinks, selected rows that disappeared are dropped
 * so a bulk action can never reach a contact the operator cannot see.
 */
export function useContactSelection(visibleIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // visibleIds is a fresh array every render; key effects on its contents.
  const visibleKey = visibleIds.join("\n");

  useEffect(() => {
    const keep = new Set(visibleKey ? visibleKey.split("\n") : []);
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => keep.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleKey]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectAll = useCallback(
    () => setSelected(new Set(visibleKey ? visibleKey.split("\n") : [])),
    [visibleKey],
  );
  const clear = useCallback(() => setSelected(new Set()), []);

  const allSelected = useMemo(
    () => visibleIds.length > 0 && visibleIds.every((id) => selected.has(id)),
    [visibleIds, selected],
  );

  return { selected, toggle, selectAll, clear, allSelected };
}
