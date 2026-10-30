"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { setConversationStarred } from "@/lib/firestore/conversations";
import { cn } from "@/lib/utils";

/**
 * Star / unstar a conversation. Used on each inbox row and in the thread
 * header; the live conversation subscription reflects the write, so no
 * local optimistic state beyond disabling while it is in flight.
 */
export function StarToggle({
  conversationId,
  starred,
  className,
}: {
  conversationId: string;
  starred: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await setConversationStarred(conversationId, !starred);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't update the star."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={starred}
      aria-label={starred ? "Unstar conversation" : "Star conversation"}
      title={starred ? "Unstar" : "Star"}
      className={cn(
        "text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1 transition-colors disabled:opacity-50",
        className
      )}
    >
      <Star
        className={cn("h-4 w-4", starred && "fill-amber-400 text-amber-500")}
      />
    </button>
  );
}
