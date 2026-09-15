"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { emailReplyFields } from "./email-reply";
import { SendLaterMenu, type SendLaterRequest } from "./send-later-menu";
import { ComposerInserts } from "./composer-inserts";
import { useMergeTagComposer } from "./use-merge-tag-composer";
import {
  ComposerModeToggle,
  InternalNoteComposer,
  type ComposerMode,
} from "./internal-note-composer";
import type { EmailMessageDoc } from "@/types/email";
import { Textarea } from "@/components/ui/textarea";
import { GoogleGIcon } from "@/components/brand/google-g-icon";
import { useWhatsappWindow } from "@/hooks/use-whatsapp-window";
import { useSubAccount } from "@/context/sub-account-context";
import { resolveWhatsappSender } from "@/lib/comms/whatsapp/resolve-sender";
import {
  WhatsappAttachmentPicker,
  attachmentSendBlock,
  useWhatsappAttachment,
} from "./whatsapp-attachment-picker";
import { ChannelSwitcher, WhatsappWindowBadge } from "./channel-switcher";
import { WhatsappTemplatePicker } from "./whatsapp-template-picker";
import {
  initialComposerChannel,
  type ChannelOption,
} from "@/lib/conversations/channel-availability";
import { cn } from "@/lib/utils";
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
 * last used when it is available, else the first available one.
 *
 * SP2 T7: `channelOptions` lists every channel with why an unavailable one
 * cannot be used; `availableChannels` must be its available subset. SP2 T8:
 * on a WhatsApp rail that enforces the service window, the window state shows
 * above the box, and a closed window disables free-form text in favour of the
 * approved-template picker.
 *
 * The "Internal note" mode (SP2 T2) swaps the whole form for
 * InternalNoteComposer, which never calls a send route.
 */
export function ConversationComposer({
  contact,
  availableChannels,
  channelOptions,
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
  /** Every channel with its availability + reason (SP2 T7). Without it, only
   *  `availableChannels` are listed. */
  channelOptions?: ChannelOption[];
  /** The thread's last-used channel; null when there is no conversation. */
  defaultChannel: ConversationChannel | null;
}) {
  const options: ChannelOption[] =
    channelOptions ??
    availableChannels.map((ch) => ({
      channel: ch as ChannelOption["channel"],
      label: LABEL[ch],
      available: true,
      code: null,
      reason: null,
    }));
  // A contact-level block on the last-used channel keeps it selected and
  // disabled — never a silent switch to another channel (SP2 T7).
  const initial =
    initialComposerChannel(options, defaultChannel) ??
    availableChannels[0] ??
    "sms";
  const [channel, setChannel] = useState<ConversationChannel>(initial);
  const [subject, setSubject] = useState("");
  const [mode, setMode] = useState<ComposerMode>("reply");
  useEffect(() => {
    setSubject(emailReplyFields(emailReply).subject);
    if (emailReply) {
      setChannel("email");
      // Reply on an email while writing an internal note means "reply".
      setMode("reply");
    }
  }, [emailReply]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const toggle = <ComposerModeToggle mode={mode} onChange={setMode} />;
  // The rail, for the attachment picker — the same resolution the window
  // hook and the send route make, so the picker appears exactly on the rails
  // that will accept the file.
  const { subAccount } = useSubAccount();
  const waSender = resolveWhatsappSender(subAccount);
  const waProvider = waSender.ok ? waSender.provider : null;
  // Keyed on contact AND channel: a file picked for one must never ride along
  // on a send to the other (see useWhatsappAttachment).
  const wa = useWhatsappAttachment(waProvider, `${contact.id}:${channel}`);
  const attachment = channel === "whatsapp" ? wa.attachment : null;
  const attachmentBlock =
    channel === "whatsapp" ? attachmentSendBlock(waProvider, wa, body) : null;

  const merge = useMergeTagComposer({
    contact,
    senderName,
    body,
    setBody,
    subject,
    setSubject,
    isEmail: channel === "email",
    replying: !!emailReply,
  });
  // The selected channel may be one this contact cannot be reached on (kept
  // selected on purpose, see `initial`): nothing sends until another is
  // picked, and a blocked WhatsApp gets no window badge or template picker —
  // the template route would refuse that contact too.
  const blockedReason =
    options.find((o) => o.channel === channel && !o.available)?.reason ?? null;
  const liveWindow = useWhatsappWindow(
    contact.id,
    mode === "reply" && channel === "whatsapp" && !blockedReason,
  );
  const waWindow = blockedReason ? null : liveWindow;
  const switcher = (
    <ChannelSwitcher
      options={options}
      value={channel}
      onChange={(ch) => {
        setChannel(ch);
        merge.reset();
      }}
    />
  );

  if (mode === "note") {
    return <InternalNoteComposer contactId={contact.id} toggle={toggle} />;
  }

  if (availableChannels.length === 0) {
    return (
      <div className="text-muted-foreground border-t px-4 py-3 text-xs">
        {toggle}
        {channelOptions ? (
          <>
            {switcher}
            No channel can reach this contact right now — each one above says
            why.
          </>
        ) : (
          <>
            No messaging channel is configured for this sub-account. Connect a
            sender in Settings to reply here.
          </>
        )}
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
  // SP2 T8 — free-form text is refused by the route outside the window; say
  // so here instead of letting the operator find out on Send.
  const windowClosed = channel === "whatsapp" && waWindow?.state.kind === "closed";
  const disabled =
    optedOut || sending || !hasIdentity || windowClosed || !!blockedReason;

  // SP2 T5 — what "Send later" books: the same payload Send would post.
  function scheduleRequest(): SendLaterRequest | null {
    const trimmed = body.trim();
    if (!trimmed || (isEmail && !subject.trim()) || channel === "web-chat") return null;
    // SP2 T7/T8: what cannot be sent now cannot be booked either — a channel
    // this contact is blocked on, or free-form WhatsApp outside the window.
    if (blockedReason || windowClosed) return null;
    // Scheduled sends carry no file (the worker does not accept one).
    if (attachment || attachmentBlock) return null;
    // Stored FINAL and never rendered by the worker, so a raw `{{…}}` blocks
    // booking exactly as it blocks Send (ruling 5).
    if (merge.blockSend()) return null;
    return {
      contactId: contact.id,
      channel,
      body: trimmed,
      ...(isEmail ? { ...emailReplyFields(emailReply), subject: subject.trim() } : {}),
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || sending || (isEmail && !subject.trim())) return;
    if (blockedReason || windowClosed || attachmentBlock) return;
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
    // Ruling 5: never ship a raw tag — and never rewrite what the operator
    // sees. Any `{{…}}` left blocks Send (see useMergeTagComposer).
    if (merge.blockSend()) return;
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
          ...(attachment ? { attachment } : {}),
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
      wa.clear();
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
      {switcher}
      {channel === "whatsapp" && waWindow && (
        <WhatsappWindowBadge state={waWindow.state} />
      )}
      {windowClosed && waWindow && (
        <WhatsappTemplatePicker contact={contact} provider={waWindow.provider} />
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
              merge.reset();
            }}
            disabled={disabled}
            required
          />
        </div>
      )}
      <Textarea
        {...merge.textareaProps}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          merge.reset();
        }}
        placeholder={
          blockedReason
            ? `${LABEL[channel]}: ${blockedReason} — pick another channel above`
            : optedOut
            ? `Contact opted out of ${LABEL[channel]}`
            : windowClosed
              ? "WhatsApp window closed — send an approved template above"
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
        className={cn(
          "min-h-[60px] resize-none px-3 py-2 text-sm",
          // On a phone a closed window's disabled box only costs thread
          // height; the template picker is the action there.
          windowClosed && "max-sm:hidden"
        )}
      />
      {merge.notice}
      {attachment && attachmentBlock && (
        <p className="text-destructive mt-1 text-xs">{attachmentBlock}</p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <ComposerInserts
            mergeContext={merge.mergeContext}
            emailActive={isEmail}
            disabled={disabled}
            onInsert={merge.insertIntoBody}
            onSubject={merge.applySnippetSubject}
            textareaRef={merge.textareaRef}
          />
          {channel === "whatsapp" && waProvider && (
            <WhatsappAttachmentPicker
              provider={waProvider}
              state={wa}
              disabled={disabled}
            />
          )}
          {merge.reviewConfigured && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={merge.insertReviewMessage}
              disabled={sending}
              title="Insert a Google review request into the reply"
            >
              <GoogleGIcon className="mr-1 h-3.5 w-3.5" />
              Ask for review
            </Button>
          )}
        </div>
        <SendLaterMenu
          disabled={
            !body.trim() || (isEmail && !subject.trim()) || disabled || !!attachment || wa.reading
          }
          buildRequest={scheduleRequest}
          onScheduled={() => setBody("")}
        >
          <Button
            type="submit"
            size="sm"
            className="rounded-r-none"
            disabled={!body.trim() || (isEmail && !subject.trim()) || disabled || !!attachmentBlock}
          >
            {sending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="mr-1 h-3.5 w-3.5" />
            )}
            Send via {LABEL[channel]}
          </Button>
        </SendLaterMenu>
      </div>
    </form>
  );
}
