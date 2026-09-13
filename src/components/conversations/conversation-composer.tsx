"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { emailReplyFields } from "./email-reply";
import { ComposerInserts } from "./composer-inserts";
import {
  ComposerModeToggle,
  InternalNoteComposer,
  type ComposerMode,
} from "./internal-note-composer";
import type { EmailMessageDoc } from "@/types/email";
import { Textarea } from "@/components/ui/textarea";
import { GoogleGIcon } from "@/components/brand/google-g-icon";
import { cn } from "@/lib/utils";
import { DEFAULT_REVIEW_SMS_TEMPLATE } from "@/lib/reviews/constants";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";
import {
  renderMergeTags,
  type MergeTagContext,
} from "@/lib/messaging/merge-tags";
import { insertAtCursor } from "@/lib/messaging/insert-at-cursor";
import type { Contact } from "@/types/contacts";
import type { ConversationChannel } from "@/types/conversations";

const LABEL: Record<ConversationChannel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  "web-chat": "Web Chat",
};

/**
 * Channel-aware reply box. Posts to the EXISTING send routes
 * (/api/comms/sms/send, /api/comms/whatsapp/send) — the snapshot listener in
 * ConversationThread surfaces the new row. Defaults to the channel the contact
 * last used; the operator can switch when more than one is available.
 *
 * The "Internal note" mode (SP2 T2) swaps the whole form for
 * InternalNoteComposer, which never calls a send route.
 */
export function ConversationComposer({
  contact,
  availableChannels,
  defaultChannel,
  emailReply = null,
  onClearEmailReply,
  senderName = null,
}: {
  emailReply?: EmailMessageDoc | null;
  /** The signed-in member's display name, for `{{user.name}}`. */
  senderName?: string | null;
  onClearEmailReply?: () => void;
  contact: Contact;
  availableChannels: ConversationChannel[];
  defaultChannel: ConversationChannel;
}) {
  const { subAccount } = useSubAccount();
  const initial = availableChannels.includes(defaultChannel)
    ? defaultChannel
    : (availableChannels[0] ?? "sms");
  const [channel, setChannel] = useState<ConversationChannel>(initial);
  const [subject, setSubject] = useState("");
  useEffect(() => {
    setSubject(emailReplyFields(emailReply).subject);
    if (emailReply) setChannel("email");
  }, [emailReply]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<ComposerMode>("reply");
  // Merge tags Send refused on (SP2 T4); cleared as soon as the text changes.
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toggle = <ComposerModeToggle mode={mode} onChange={setMode} />;

  // "Ask for review" — only when a review link is configured. Inserts the
  // rendered review message into the composer (free-form) so the operator can
  // tweak it and send on the current channel. For WhatsApp this works WITHOUT an
  // approved template because the customer's recent inbound keeps the 24h window
  // open (the send route 409s if it has closed).
  const reviewCfg = subAccount?.googleReviewConfig ?? null;
  // The configured link only, through the canonical seam — never a listing's proposal.
  const reviewUrl = resolveReviewUrl(subAccount).configured;
  const reviewConfigured = !!reviewUrl;

  const mergeContext: MergeTagContext = {
    contact,
    businessName: subAccount?.name ?? "",
    userName: senderName,
    reviewUrl: reviewCfg?.reviewUrl,
  };

  function insertReviewMessage() {
    if (!reviewCfg || !reviewUrl) return;
    const msg = renderMergeTags(
      reviewCfg.messageTemplate || DEFAULT_REVIEW_SMS_TEMPLATE,
      mergeContext
    ).text;
    // Preserve anything the operator already typed (e.g. a thank-you).
    setBody((prev) => (prev.trim() ? `${prev.trim()} ${msg}` : msg));
  }

  function insertIntoBody(text: string) {
    const el = bodyRef.current;
    const next = insertAtCursor(
      body,
      text,
      el && document.activeElement === el ? el.selectionStart : null,
      el && document.activeElement === el ? el.selectionEnd : null
    );
    setBody(next.value);
    setUnresolved([]);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  }

  if (mode === "note") {
    return <InternalNoteComposer contactId={contact.id} toggle={toggle} />;
  }

  if (availableChannels.length === 0) {
    return (
      <div className="text-muted-foreground border-t px-4 py-3 text-xs">
        {toggle}
        No messaging channel is configured for this sub-account. Connect a
        sender in Settings to reply here.
      </div>
    );
  }

  // Meta (Messenger / Instagram) replies post to a different route, identify
  // the recipient by `metaUserId` (not phone), and have no STOP-style opt-out.
  const isMeta = channel === "messenger" || channel === "instagram";
  const isEmail = channel === "email";
  const optedOut = isEmail
    ? !!contact.emailOptedOut
    : isMeta
      ? false
      : channel === "sms"
        ? !!contact.smsOptedOut
        : !!contact.whatsappOptedOut;
  const endpoint = isEmail
    ? "/api/comms/email/send"
    : isMeta
      ? "/api/comms/meta/send"
      : channel === "sms"
        ? "/api/comms/sms/send"
        : "/api/comms/whatsapp/send";
  const hasIdentity = isEmail
    ? !!contact.email
    : isMeta
      ? !!contact.metaUserId
      : !!contact.phone;
  const disabled = optedOut || sending || !hasIdentity;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || sending || (isEmail && !subject.trim())) return;
    if (!hasIdentity) {
      toast.error(
        isEmail
          ? "This contact has no email address."
          : isMeta
            ? "This contact hasn't messaged via Facebook/Instagram."
            : "This contact has no phone number."
      );
      return;
    }
    if (optedOut) {
      toast.error(`This contact opted out of ${LABEL[channel]}.`);
      return;
    }
    // Ruling 5: never ship a raw tag. Typed tags that DO resolve are filled in
    // and Send stops once, so the operator sees the exact text before it goes.
    const renderedBody = renderMergeTags(trimmed, mergeContext);
    const renderedSubject = renderMergeTags(
      isEmail ? subject.trim() : "",
      mergeContext
    );
    const missing = [...renderedBody.unresolved, ...renderedSubject.unresolved];
    if (missing.length) {
      setUnresolved([...new Set(missing)]);
      return;
    }
    if (
      renderedBody.text !== trimmed ||
      (isEmail && renderedSubject.text !== subject.trim())
    ) {
      setBody(renderedBody.text);
      if (isEmail) setSubject(renderedSubject.text);
      toast.info(
        "Merge fields filled in. Check the message, then press Send again."
      );
      return;
    }
    setSending(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          body: trimmed,
          ...(isMeta ? { channel } : {}),
          ...(isEmail
            ? { ...emailReplyFields(emailReply), subject: subject.trim() }
            : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        sent?: boolean;
        warning?: string;
      };
      if (isEmail && data.sent && (!res.ok || data.warning || !data.ok)) {
        setBody("");
        toast.warning(
          data.warning ??
            data.error ??
            "Email sent, but saving to Conversations failed. Do not resend."
        );
        return;
      }
      if (!res.ok || !data.ok) {
        // Never a bare "Couldn't send.". When the body is not JSON — a proxy
        // error page, a gateway timeout — the status is the only fact we have,
        // and an operator with a status can tell "it was refused" from "the
        // server is down". Without it, both look identical and identically
        // unactionable.
        throw new Error(data.error ?? `Couldn't send (HTTP ${res.status}).`);
      }
      setBody("");
      // Snapshot listener appends the row.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t px-4 py-3">
      {toggle}
      {availableChannels.length > 1 && (
        <div className="mb-2 flex gap-1">
          {availableChannels.map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => setChannel(ch)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                channel === ch
                  ? "border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {LABEL[ch]}
            </button>
          ))}
        </div>
      )}
      {isEmail && (
        <div className="mb-2 space-y-2">
          {emailReply && (
            <p className="text-muted-foreground text-xs">
              Replying to {emailReply.subject || "(no subject)"}{" "}
              <button
                type="button"
                className="underline"
                onClick={onClearEmailReply}
              >
                New email
              </button>
            </p>
          )}
          <Input
            aria-label="Email subject"
            placeholder="Subject"
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setUnresolved([]);
            }}
            disabled={disabled}
            required
          />
        </div>
      )}
      <Textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setUnresolved([]);
        }}
        placeholder={
          optedOut
            ? `Contact opted out of ${LABEL[channel]}`
            : `Reply via ${LABEL[channel]} to ${
                (isEmail
                  ? contact.email
                  : isMeta
                    ? contact.name
                    : contact.phone) || "this contact"
              }…`
        }
        rows={2}
        disabled={disabled}
        className="min-h-[60px] resize-none px-3 py-2 text-sm"
      />
      {unresolved.length > 0 && (
        <p
          role="alert"
          data-testid="merge-error"
          className="text-destructive mt-1 text-xs"
        >
          Not sent: no value for {unresolved.join(", ")}. Fill it in or remove
          it.
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <ComposerInserts
            mergeContext={mergeContext}
            emailActive={isEmail}
            disabled={disabled}
            onInsert={insertIntoBody}
            onSubject={(s) => {
              setSubject(s);
              setUnresolved([]);
            }}
          />
          {reviewConfigured && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={insertReviewMessage}
              disabled={sending}
              title="Insert a Google review request into the reply"
            >
              <GoogleGIcon className="mr-1 h-3.5 w-3.5" />
              Ask for review
            </Button>
          )}
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={!body.trim() || (isEmail && !subject.trim()) || disabled}
        >
          {sending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="mr-1 h-3.5 w-3.5" />
          )}
          Send via {LABEL[channel]}
        </Button>
      </div>
    </form>
  );
}
