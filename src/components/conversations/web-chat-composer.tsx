"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Operator reply box for a Web Chat conversation (live human takeover).
 * Posts to /api/comms/web-chat/send; the visitor's open widget picks the
 * reply up via its delivery poll. Sending pauses the AI on this thread (the
 * send route passes pauseBot), so the bot won't talk over the operator.
 */
export function WebChatComposer({
  subAccountId,
  sessionId,
}: {
  subAccountId: string;
  sessionId: string;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/comms/web-chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subAccountId, sessionId, body: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Couldn't send.");
      setBody("");
      // The operator-side thread listener appends the new row.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t px-4 py-3">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Reply in the live chat widget…"
        rows={2}
        disabled={sending}
        className="min-h-[60px] resize-none px-3 py-2 text-sm"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          Sending takes over from the AI — it appears in the visitor’s open
          chat window.
        </span>
        <Button type="submit" size="sm" disabled={!body.trim() || sending}>
          {sending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="mr-1 h-3.5 w-3.5" />
          )}
          Send
        </Button>
      </div>
    </form>
  );
}
