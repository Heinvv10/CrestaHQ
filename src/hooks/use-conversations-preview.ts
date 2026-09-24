"use client";

import { useEffect, useState } from "react";
import { fetchNewestConversations } from "@/lib/firestore/conversations";
import type { ConversationDoc } from "@/types/conversations";

/**
 * The `count` most recently active conversations, fetched once while
 * `enabled` — a first paint for the inbox while the full list is still
 * downloading (~2 MB on a 5,000-conversation sub-account). Returns null when
 * disabled, before it lands, or if the fetch fails; a result that lands after
 * `enabled` flips off (the full list won the race) or the sub-account changed
 * is dropped.
 */
export function useConversationsPreview(
  subAccountId: string | null,
  count: number,
  enabled: boolean
): ConversationDoc[] | null {
  const [preview, setPreview] = useState<ConversationDoc[] | null>(null);

  useEffect(() => {
    setPreview(null);
    if (!enabled || !subAccountId) return;
    let live = true;
    fetchNewestConversations(subAccountId, count)
      .then((list) => {
        if (live) setPreview(list);
      })
      .catch((err) => {
        // Best-effort: the full list still loads, only the early paint is lost.
        console.warn("[conversations] newest-page preview failed", err);
      });
    return () => {
      live = false;
    };
  }, [enabled, subAccountId, count]);

  return preview;
}
