"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { toast } from "sonner";
import { FileText, Loader2, MessagesSquare, Send } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WhatsappTemplateSender } from "@/components/contacts/whatsapp-template-sender";
import { toDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Contact } from "@/types/contacts";
import type { MessageDoc } from "@/types/messages";
import { WhatsappMediaAttachment } from "@/components/conversations/whatsapp-media-attachment";
import {
  WhatsappAttachmentPicker,
  attachmentSendBlock,
  useWhatsappAttachment,
} from "@/components/conversations/whatsapp-attachment-picker";
import { whatsappSenderNumber } from "@/lib/comms/whatsapp/sender-configured";
import { resolveWhatsappSender } from "@/lib/comms/whatsapp/resolve-sender";

const WINDOW_HOURS = 24;

/**
 * Per-contact WhatsApp chat thread. Only rendered when the parent sub-account
 * has a configured WhatsApp sender (the contact-profile page guards this).
 *
 * Mirrors the SMS thread, with WhatsApp's 24-hour session window enforced in
 * the composer: free-form replies are only allowed within 24h of the
 * contact's last inbound message. Outside the window the composer is disabled
 * with a note (re-opening requires an approved template — a later release).
 * The server enforces the same window, so the UI guard is a courtesy.
 */
export function ContactWhatsappThread({ contact }: { contact: Contact }) {
  const { subAccount } = useSubAccount();
  const [messages, setMessages] = useState<MessageDoc[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [templateMode, setTemplateMode] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!contact.id) return;
    const db = getFirebaseDb();
    const q = query(
      collection(db, `contacts/${contact.id}/whatsappMessages`),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map(
          (d) => ({ id: d.id, ...d.data() }) as MessageDoc,
        );
        setMessages(rows);
        setHydrated(true);
      },
      () => setHydrated(true),
    );
    return () => unsub();
  }, [contact.id]);

  useEffect(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages.length]);

  // Mark unread inbound messages as read on mount.
  useEffect(() => {
    if (!hydrated || messages.length === 0) return;
    const unread = messages.filter(
      (m) => m.direction === "inbound" && !m.readAt,
    );
    if (unread.length === 0) return;
    const db = getFirebaseDb();
    Promise.all(
      unread.map((m) =>
        setDoc(
          doc(db, `contacts/${contact.id}/whatsappMessages/${m.id}`),
          { readAt: serverTimestamp() },
          { merge: true },
        ),
      ),
    ).catch((err) => {
      console.warn("[whatsapp-thread] mark-read failed", err);
    });
  }, [hydrated, messages, contact.id]);

  const optedOut = !!contact.whatsappOptedOut;
  const fromNumber = whatsappSenderNumber(subAccount);

  // Compute whether the 24h session window is open from the loaded thread.
  const windowOpen = useMemo(() => {
    let latest: number | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.direction === "inbound") {
        latest = toDate(messages[i]!.createdAt)?.getTime() ?? null;
        break;
      }
    }
    return (
      latest !== null && Date.now() - latest < WINDOW_HOURS * 3600 * 1000
    );
  }, [messages]);

  // The 24-hour session window is a Meta rule, and it binds the rails that
  // talk to Meta. The bridge does not enforce it (capabilities: enforcesWindow
  // false), and it cannot send templates either — so applying the window here
  // would disable the composer and tell the operator to use a template that
  // rail has no way to send. The send route makes the real decision per rail;
  // this only decides what to grey out.
  //
  // The rail comes from the sender registry — the SAME resolution the send
  // route makes — not from `whatsappProvider` alone. A workspace whose
  // registry default differs from that field would otherwise be offered a
  // picker (and a window rule) for a rail its sends do not go out on.
  const resolved = resolveWhatsappSender(subAccount);
  const railProvider = resolved.ok ? resolved.provider : null;
  const railEnforcesWindow = resolved.ok ? resolved.capabilities.enforcesWindow : false;
  const railSupportsTemplates = resolved.ok ? resolved.capabilities.supportsTemplates : false;
  const windowBlocks = railEnforcesWindow && !windowOpen;
  const wa = useWhatsappAttachment(railProvider, contact.id);
  const attachmentBlock = attachmentSendBlock(railProvider, wa, body);

  // An unresolvable sender is refused by the route; say so here instead.
  const canSend = resolved.ok && !optedOut && !windowBlocks && !!contact.phone;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    if (!canSend || attachmentBlock) return;
    const attachment = wa.attachment;
    setSending(true);
    try {
      const res = await fetch("/api/comms/whatsapp/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          body: trimmed,
          ...(attachment ? { attachment } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't send.");
      }
      setBody("");
      wa.clear();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  const placeholder = !resolved.ok
    ? resolved.error
    : optedOut
    ? "Contact opted out of WhatsApp"
    : windowBlocks
      ? "24-hour window closed — a template is required to message again"
      : `Reply to ${contact.phone}…`;

  return (
    <section className="rounded-2xl border bg-card">
      <header className="flex items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-green-500/10 text-green-600 dark:text-green-400">
            <MessagesSquare className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">WhatsApp</h2>
            <p className="text-[11px] text-muted-foreground">
              WhatsApp thread with {contact.name || contact.phone}.
              {fromNumber ? ` From ${fromNumber}.` : ""}
            </p>
          </div>
        </div>
        {optedOut && (
          <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-700 dark:text-rose-400">
            Opted out
          </span>
        )}
      </header>

      <div
        ref={scrollerRef}
        className="max-h-[420px] min-h-[200px] space-y-2 overflow-y-auto p-4"
      >
        {!hydrated ? (
          <div className="space-y-2">
            <div className="h-12 w-2/3 animate-pulse rounded-lg bg-muted" />
            <div className="ml-auto h-12 w-3/4 animate-pulse rounded-lg bg-muted" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full min-h-[150px] items-center justify-center text-center">
            <p className="text-xs text-muted-foreground">
              No WhatsApp messages yet. Inbound messages from {contact.phone}{" "}
              will land here in real time.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} contactId={contact.id} />
          ))
        )}
      </div>

      {!optedOut && windowBlocks && messages.length > 0 && !templateMode && (
        <div className="border-t bg-amber-500/5 px-4 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          The 24-hour messaging window has closed. Free-form replies are only
          allowed within 24h of the contact&apos;s last message — send an
          approved template to re-open the conversation.
        </div>
      )}

      {!optedOut && templateMode ? (
        <div className="border-t">
          <div className="flex items-center justify-between px-4 pt-3">
            <span className="text-xs font-medium">Send an approved template</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTemplateMode(false)}
            >
              Back to message
            </Button>
          </div>
          <WhatsappTemplateSender
            contact={contact}
            onSent={() => setTemplateMode(false)}
          />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="border-t px-4 py-3">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={placeholder}
            rows={2}
            disabled={!canSend || sending}
            className="resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
          />
          {wa.attachment && attachmentBlock && (
            <p className="mt-1 text-xs text-destructive">{attachmentBlock}</p>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            {railProvider && (
              <WhatsappAttachmentPicker
                provider={railProvider}
                state={wa}
                disabled={!canSend || sending}
              />
            )}
            {/* Templates are a Meta-rail feature. Offering the button on a
                rail that cannot send one (capabilities: supportsTemplates
                false) is a control whose every use fails. */}
            {!optedOut && railSupportsTemplates && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setTemplateMode(true)}
              >
                <FileText className="mr-1 h-3.5 w-3.5" />
                Send template
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              className="ml-auto"
              disabled={!body.trim() || !canSend || sending || !!attachmentBlock}
            >
              {sending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="mr-1 h-3.5 w-3.5" />
              )}
              Send
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function MessageBubble({
  message,
  contactId,
}: {
  message: MessageDoc;
  contactId: string;
}) {
  const isOutbound = message.direction === "outbound";
  const ts = toDate(message.createdAt);
  return (
    <div className={cn("flex flex-col", isOutbound ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[78%] rounded-2xl px-3 py-2 text-sm",
          isOutbound
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-muted",
          message.status === "failed" && "ring-2 ring-destructive",
        )}
      >
        <WhatsappMediaAttachment
          contactId={contactId}
          messageId={message.id}
          media={message.media}
          dropped={message.mediaDropped}
        />
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        {message.buttons && message.buttons.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-current/10 pt-2">
            {message.buttons.map((btn, i) => (
              <span
                key={i}
                className="rounded-full bg-background/60 px-2 py-0.5 text-[11px] font-medium text-current opacity-80"
                title={btn.type === "url" ? btn.url : undefined}
              >
                {btn.type === "url" ? `🔗 ${btn.text} (${btn.url})` : btn.text}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span>
          {ts
            ? ts.toLocaleString(undefined, {
                hour: "numeric",
                minute: "2-digit",
                month: "short",
                day: "numeric",
              })
            : ""}
        </span>
        {message.status === "failed" && (
          <span className="text-destructive">· failed</span>
        )}
      </div>
    </div>
  );
}
