"use client";

import { MailOpen, PanelRight } from "lucide-react";
import { toast } from "sonner";
import { markConversationUnread } from "@/lib/firestore/conversations";
import { Button } from "@/components/ui/button";
import { StarToggle } from "@/components/conversations/star-toggle";
import type { ConversationDoc } from "@/types/conversations";

/** Star + Mark as unread for the open thread (SP2 I6, I7). */
export function ThreadTriageActions({
  conversationId,
  conversation,
}: {
  conversationId: string;
  conversation: ConversationDoc;
}) {
  async function markUnread() {
    try {
      await markConversationUnread(conversationId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't mark unread.");
    }
  }

  return (
    <>
      <StarToggle
        conversationId={conversationId}
        starred={conversation.starred === true}
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={markUnread}
        disabled={(conversation.unreadCount ?? 0) > 0}
        aria-label="Mark as unread"
        title="Mark as unread"
      >
        <MailOpen className="h-4 w-4" />
      </Button>
    </>
  );
}

/**
 * Contact details toggle. Shown from lg up: the panel overlays the thread on
 * lg (the split view leaves no room to dock it) and docks beside it on xl.
 */
export function DetailsToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant={open ? "secondary" : "outline"}
      size="sm"
      onClick={onToggle}
      aria-pressed={open}
      className="hidden lg:inline-flex"
      title="Show contact details + activity"
    >
      <PanelRight className="mr-1 h-3.5 w-3.5" />
      Details
    </Button>
  );
}
