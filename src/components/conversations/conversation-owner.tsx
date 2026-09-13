"use client";

import { useState } from "react";
import { toast } from "sonner";
import { UserRound } from "lucide-react";
import { AssigneeSelect, SELECT_CLASS } from "@/components/assignee-select";
import { cn } from "@/lib/utils";
import type { Contact } from "@/types/contacts";

/**
 * Conversation "Owner" picker (SP2 T1). The owner IS the contact's owner, so
 * this writes the CONTACT through PATCH /api/contacts/{id} — the same server
 * path the contact form uses — and never the conversation. The server mirrors
 * the value onto the conversation (lib/server/conversation-mirror.ts), which
 * is what the inbox scope filter reads. The value shown comes from the live
 * contact subscription, so it is always the source of truth.
 */
export function ConversationOwner({
  contact,
  id,
  className,
}: {
  contact: Contact;
  id: string;
  className?: string;
}) {
  const [saving, setSaving] = useState(false);

  async function assign(uid: string | null) {
    if (uid === (contact.assignedToUid ?? null)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToUid: uid }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          payload.error ?? `Couldn't change the owner (HTTP ${res.status}).`
        );
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't change the owner."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <label
      htmlFor={id}
      className={cn("flex items-center gap-1.5 text-[11px]", className)}
      title="Owner — the contact's assigned team member"
    >
      <UserRound className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
      <span className="text-muted-foreground font-medium">Owner</span>
      <span className={cn("min-w-0", saving && "opacity-60")}>
        <AssigneeSelect
          id={id}
          value={contact.assignedToUid ?? null}
          onChange={(uid) => void assign(uid)}
          className={cn(SELECT_CLASS, "h-7 w-36 text-xs")}
        />
      </span>
    </label>
  );
}
