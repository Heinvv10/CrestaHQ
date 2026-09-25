"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContactPicker } from "@/components/quotes/contact-picker";
import { useSubAccountContacts } from "@/context/contacts-context";
import { sendResultMessage } from "./send-result";

/**
 * Send Review Request (SP5 d1): pick a contact in this sub-account, send the
 * configured review request to them now through the existing manual route —
 * the same dispatcher as the contact profile's Request review, which skips the
 * cooldown for a manual send. The dispatcher's answer is shown inline.
 */

type Result = { state: "sent" | "refused" | "error"; message: string } | null;

export function SendReviewRequestButton({ onSent }: { onSent?: () => void }) {
  const [open, setOpen] = useState(false);
  // Only starts the sub-account's contacts download once the dialog opens.
  const shared = useSubAccountContacts(open);
  const contacts = shared.error ? "error" : shared.loading ? null : shared.contacts;
  const [contactId, setContactId] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result>(null);
  /** Who this dialog last sent to: Send stays off for them, however they are re-picked. */
  const [sentTo, setSentTo] = useState<string | null>(null);

  function openDialog() {
    setContactId("");
    setResult(null);
    setSentTo(null);
    setOpen(true);
  }

  async function send() {
    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/comms/review-request/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId }),
      });
      const data = (await res.json().catch(() => ({}))) as { sent?: boolean; reason?: string; error?: string };
      if (!res.ok) setResult({ state: "error", message: data.error ?? sendResultMessage(undefined) });
      else if (data.sent) {
        setResult({ state: "sent", message: "Review request sent." });
        setSentTo(contactId);
        onSent?.();
      } else setResult({ state: "refused", message: sendResultMessage(data.reason) });
    } catch {
      setResult({ state: "error", message: sendResultMessage(undefined) });
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={openDialog} data-testid="rep-send-open">
        <Send className="mr-1 h-3.5 w-3.5" /> Send Review Request
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="rep-send-dialog">
          <DialogHeader>
            <DialogTitle>Send a review request</DialogTitle>
            <DialogDescription>
              Sends your Google review request to one contact now, over the channel set in the review-request settings.
            </DialogDescription>
          </DialogHeader>
          {contacts === null ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="rep-send-contacts-loading">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading contacts…
            </p>
          ) : contacts === "error" ? (
            <p role="alert" className="text-sm text-destructive" data-testid="rep-send-contacts-error">
              Contacts could not be loaded. Close this and try again.
            </p>
          ) : (
            <ContactPicker
              contacts={contacts}
              value={contactId}
              onChange={(id) => {
                setContactId(id);
                setResult(null);
              }}
              title="Who should get the review request?"
            />
          )}
          {result && (
            <p
              role={result.state === "sent" ? "status" : "alert"}
              data-testid="rep-send-result"
              data-state={result.state}
              className={result.state === "sent" ? "text-sm text-emerald-700 dark:text-emerald-400" : "text-sm text-destructive"}
            >
              {result.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {result?.state === "sent" ? "Done" : "Cancel"}
            </Button>
            {/* After a send, off for that contact — no double send by a second click or a re-pick. */}
            <Button onClick={send} disabled={!contactId || sending || contactId === sentTo} data-testid="rep-send-submit">
              {sending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
