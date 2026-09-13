"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchSnippets } from "@/lib/snippets/client";
import type { SnippetDto } from "@/types/snippets";

/**
 * The sub-account's snippets, fetched through the API (the collection is
 * server-only). `enabled: false` defers the fetch — the composer loads them
 * only when its picker opens. Call `reload()` after a write.
 */
export function useSnippets(
  subAccountId: string | null | undefined,
  enabled = true
) {
  const [snippets, setSnippets] = useState<SnippetDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!subAccountId) return;
    setLoading(true);
    try {
      setSnippets(await fetchSnippets(subAccountId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load snippets.");
    } finally {
      setLoading(false);
    }
  }, [subAccountId]);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { snippets, loading, error, reload };
}
