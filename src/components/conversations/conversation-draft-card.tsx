"use client";

import { createElement, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { discardConversationDraft } from "@/lib/firestore/conversations";
import type { ConversationChannel, ConversationDraft } from "@/types/conversations";

const LABEL: Record<ConversationChannel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  "web-chat": "Web Chat",
};

/**
 * Suggest-mode draft awaiting approval. The operator can edit the text, then
 * Approve & send (posts to the channel's send route — the human-send upsert
 * clears the draft + pauses the bot server-side) or Discard.
 *
 * Channel-agnostic: contact-keyed channels send by `contactId`; web chat sends
 * by `{subAccountId, sessionId}` (delivered to the visitor's widget via poll).
 * `conversationId` is the doc id the discard writes to.
 *
 * Keyed by the draft's identity, so a newer draft arriving while the card is
 * open replaces the text being edited instead of inheriting it. An email
 * approve names the draft (`draftId`): the route claims it server-side and
 * refuses with 409 if it was replaced or already sent.
 */
type DraftCardProps = {
  conversationId: string;
  contactId: string | null;
  subAccountId: string;
  sessionId?: string | null;
  draft: ConversationDraft;
};

export function ConversationDraftCard(props: DraftCardProps) {
  return createElement(DraftCardBody, { ...props, key: props.draft.id ?? props.draft.body });
}

function DraftCardBody({
  conversationId,
  contactId,
  subAccountId,
  sessionId = null,
  draft,
}: DraftCardProps) {
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState<null | "approve" | "discard">(null);
  // Sent: hidden until the conversation listener drops the draft, so a
  // second click can't send it again.
  const [sent, setSent] = useState(false);
  const isWebChat = draft.channel === "web-chat";
  const isMeta =
    draft.channel === "messenger" || draft.channel === "instagram";
  const endpoint = isWebChat
    ? "/api/comms/web-chat/send"
    : isMeta
      ? "/api/comms/meta/send"
      : draft.channel === "email"
        ? "/api/comms/email/send"
        : draft.channel === "sms"
          ? "/api/comms/sms/send"
          : "/api/comms/whatsapp/send";

  async function approve() {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (draft.channel === "email" && (!draft.emailReply || !draft.id)) {
      toast.error("This draft has no email to reply to. Reply from the composer instead.");
      return;
    }
    setBusy("approve");
    try {
      const payload = isWebChat
        ? { subAccountId, sessionId, body: trimmed }
        : {
            contactId,
            body: trimmed,
            // The meta send route needs the platform to reply on; SMS/WhatsApp
            // routes ignore the extra field.
            ...(isMeta ? { channel: draft.channel } : {}),
            // An email draft answers the email it was written for: same
            // thread, "Re:" subject — set server-side when it was drafted;
            // the route sends with the stored ones of the draft it claims.
            ...(draft.channel === "email" ? { ...draft.emailReply, draftId: draft.id } : {}),
          };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Couldn't send.");
      // Every send route clears pendingDraft server-side (email's claims it
      // before sending).
      setSent(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    setBusy("discard");
    try {
      await discardConversationDraft(conversationId);
    } finally {
      setBusy(null);
    }
  }

  if (sent) return null;

  return (
    <div className="border-t border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
        <Sparkles className="h-3.5 w-3.5" />
        AI suggested reply · {LABEL[draft.channel]} · edit before sending
      </div>
      {draft.escalationKeyword && (
        <p className="mb-1.5 text-xs font-medium text-red-600 dark:text-red-400">
          Escalation keyword: &ldquo;{draft.escalationKeyword}&rdquo; — check before replying.
        </p>
      )}
      {draft.emailReply && (
        <p className="mb-1.5 truncate text-xs text-muted-foreground">
          Subject: {draft.emailReply.subject}
        </p>
      )}
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={draft.channel === "email" ? 8 : 3}
        className="resize-none bg-background text-sm"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={discard}
          disabled={!!busy}
        >
          {busy === "discard" ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="mr-1 h-3.5 w-3.5" />
          )}
          Discard
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={approve}
          disabled={!!busy || !body.trim()}
        >
          {busy === "approve" ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="mr-1 h-3.5 w-3.5" />
          )}
          Approve &amp; send
        </Button>
      </div>
    </div>
  );
}
