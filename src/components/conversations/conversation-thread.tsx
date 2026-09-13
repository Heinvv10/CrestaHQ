"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { CheckCheck } from "lucide-react";
import { getFirebaseDb } from "@/lib/firebase/client";
import { subscribeToNotes } from "@/lib/firestore/contacts";
import { mergeThreadItems, type ThreadItem } from "@/lib/conversations/thread-items";
import { toDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EmailMessageDoc } from "@/types/email";
import { Button } from "@/components/ui/button";
import type { MessageDoc } from "@/types/messages";
import type { ConversationChannel } from "@/types/conversations";
import type { ConversationTheme } from "@/hooks/use-conversation-theme";
import type { Note } from "@/types/contacts";
import { ThreadNote } from "./thread-note";
import { ThreadScheduled } from "./thread-scheduled";
import { useScheduledMessages } from "@/hooks/use-scheduled-messages";

type ChannelMessage =
  | (MessageDoc & { channel: ConversationChannel })
  | (EmailMessageDoc & { channel: "email" });

const CHANNEL_LABEL: Record<ConversationChannel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  "web-chat": "Web Chat",
};

const CHANNEL_CHIP: Record<ConversationChannel, string> = {
  email: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  sms: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  whatsapp: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  messenger: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  instagram: "bg-pink-500/10 text-pink-700 dark:text-pink-400",
  "web-chat": "bg-sky-500/10 text-sky-700 dark:text-sky-400",
};

/** Meta rows carry their own channel discriminator on the doc. */
type MetaMessageDoc = MessageDoc & { channel?: ConversationChannel };

/**
 * The merged conversation timeline. For the contact-keyed channels it
 * subscribes to the contact's SMS (`messages`), WhatsApp (`whatsappMessages`),
 * and BETA Meta (`metaMessages`) subcollections, tags each row with its
 * channel, and renders one time-ordered stream — a read-time merge over the
 * existing per-contact threads (no data is moved).
 *
 * When `sessionId` is passed (a web-chat conversation), it instead reads that
 * session's transcript at `subAccounts/{subAccountId}/webChatSessions/{id}/
 * messages` — web-chat messages live under the session, not a contact.
 *
 * Internal notes (SP2 T2) — the contact's `notes` rows, the same ones its
 * timeline shows — are interleaved by time whenever there is a contact,
 * including a web-chat session that has captured one. They are rendered as
 * notes, never as bubbles.
 *
 * Scheduled messages (SP2 T5) — pending, sending or failed — are interleaved
 * at their send time for contact threads, as dashed "Scheduled for …" items
 * with Cancel. Sent ones are left out (the real message row shows instead),
 * as are cancelled ones.
 */
export function ConversationThread({
  contactId,
  sessionId = null,
  subAccountId,
  theme = "standard",
  onEmailReply,
  scheduleTimeZone = "UTC",
}: {
  contactId: string;
  onEmailReply?: (message: EmailMessageDoc) => void;
  /** Web-chat only: read the session transcript instead of contact threads. */
  sessionId?: string | null;
  /** Required alongside sessionId to locate the session doc; for a contact
   *  thread it scopes the scheduled-messages read. */
  subAccountId?: string;
  theme?: ConversationTheme;
  /** Zone scheduled times are shown in (see lib/conversations/schedule-time). */
  scheduleTimeZone?: string;
}) {
  const [email, setEmail] = useState<EmailMessageDoc[]>([]);
  const [emailReady, setEmailReady] = useState(false);
  const [emailError, setEmailError] = useState(false);
  const [sms, setSms] = useState<MessageDoc[]>([]);
  const [wa, setWa] = useState<MessageDoc[]>([]);
  const [meta, setMeta] = useState<MetaMessageDoc[]>([]);
  const [web, setWeb] = useState<MessageDoc[]>([]);
  const [smsReady, setSmsReady] = useState(false);
  const [waReady, setWaReady] = useState(false);
  const [metaReady, setMetaReady] = useState(false);
  const [webReady, setWebReady] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesReady, setNotesReady] = useState(false);
  const [notesError, setNotesError] = useState(false);
  const isWebChat = !!sessionId && !!subAccountId;
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const db = getFirebaseDb();

    // Web-chat mode: single source under the session. The contact-thread
    // listeners are skipped entirely.
    if (isWebChat) {
      const unsubWeb = onSnapshot(
        query(
          collection(
            db,
            `subAccounts/${subAccountId}/webChatSessions/${sessionId}/messages`
          ),
          orderBy("createdAt", "asc")
        ),
        (snap) => {
          setWeb(
            snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MessageDoc)
          );
          setWebReady(true);
        },
        () => setWebReady(true)
      );
      return () => unsubWeb();
    }

    if (!contactId) return;
    const unsubEmail = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/emailMessages`),
        orderBy("createdAt", "asc")
      ),
      (snap) => {
        setEmail(
          snap.docs.map((d) => ({ id: d.id, ...d.data() }) as EmailMessageDoc)
        );
        setEmailReady(true);
        setEmailError(false);
      },
      () => {
        setEmailReady(true);
        setEmailError(true);
      }
    );
    const unsubSms = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/messages`),
        orderBy("createdAt", "asc")
      ),
      (snap) => {
        setSms(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MessageDoc));
        setSmsReady(true);
      },
      () => setSmsReady(true)
    );
    const unsubWa = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/whatsappMessages`),
        orderBy("createdAt", "asc")
      ),
      (snap) => {
        setWa(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MessageDoc));
        setWaReady(true);
      },
      () => setWaReady(true)
    );
    const unsubMeta = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/metaMessages`),
        orderBy("createdAt", "asc")
      ),
      (snap) => {
        setMeta(
          snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MetaMessageDoc)
        );
        setMetaReady(true);
      },
      () => setMetaReady(true)
    );
    return () => {
      unsubEmail();
      unsubSms();
      unsubWa();
      unsubMeta();
    };
  }, [contactId, isWebChat, sessionId, subAccountId]);

  // Notes live on the contact, so they follow `contactId` for both modes.
  useEffect(() => {
    if (!contactId) return;
    return subscribeToNotes(
      contactId,
      (list) => {
        setNotes(list);
        setNotesReady(true);
        setNotesError(false);
      },
      () => {
        setNotesReady(true);
        setNotesError(true);
      }
    );
  }, [contactId]);

  const scheduledRead = useScheduledMessages(
    isWebChat ? null : subAccountId,
    isWebChat ? null : contactId,
    email.length + sms.length + wa.length + meta.length
  );

  const merged = useMemo<ThreadItem<ChannelMessage>[]>(() => {
    const threadNotes = contactId ? notes : [];
    if (isWebChat) {
      return mergeThreadItems(
        web.map((m) => ({ ...m, channel: "web-chat" as const })),
        threadNotes
      );
    }
    const all: ChannelMessage[] = [
      ...email.map((m) => ({ ...m, channel: "email" as const })),
      ...sms.map((m) => ({ ...m, channel: "sms" as const })),
      ...wa.map((m) => ({ ...m, channel: "whatsapp" as const })),
      ...meta.map((m) => ({
        ...m,
        channel: (m.channel ?? "messenger") as ConversationChannel,
      })),
    ];
    const scheduled = scheduledRead.messages.filter(
      (m) => m.status === "pending" || m.status === "sending" || m.status === "failed"
    );
    return mergeThreadItems(all, threadNotes, scheduled);
  }, [sms, wa, meta, web, email, isWebChat, notes, contactId, scheduledRead.messages]);

  const hydrated =
    (!contactId || notesReady) &&
    (isWebChat ? webReady : smsReady && waReady && metaReady && emailReady);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [merged.length]);

  return (
    <div
      ref={scrollerRef}
      data-testid="conversation-thread"
      className="flex-1 space-y-2 overflow-y-auto p-4"
    >
      {emailError && (
        <p role="alert" className="text-destructive text-xs">
          Email messages could not be loaded. Refresh to try again.
        </p>
      )}
      {notesError && (
        <p role="alert" className="text-destructive text-xs">
          Internal notes could not be loaded. Refresh to try again.
        </p>
      )}
      {scheduledRead.error && (
        <p role="alert" className="text-destructive text-xs">
          Scheduled messages could not be loaded. Refresh to try again.
        </p>
      )}
      {!hydrated ? (
        <div className="space-y-2">
          <div className="bg-muted h-12 w-2/3 animate-pulse rounded-lg" />
          <div className="bg-muted ml-auto h-12 w-3/4 animate-pulse rounded-lg" />
        </div>
      ) : merged.length === 0 ? (
        <div className="flex h-full min-h-[150px] items-center justify-center text-center">
          <p className="text-muted-foreground text-xs">
            No messages yet. Reply below to start the conversation.
          </p>
        </div>
      ) : (
        merged.map((item) =>
          item.kind === "note" ? (
            <ThreadNote key={item.key} note={item.note} />
          ) : item.kind === "scheduled" ? (
            <ThreadScheduled
              key={item.key}
              message={item.scheduled}
              timeZone={scheduleTimeZone}
              onCancel={scheduledRead.cancel}
            />
          ) : (
            <ChannelBubble
              key={item.key}
              message={item.message}
              theme={theme}
              onEmailReply={onEmailReply}
            />
          )
        )
      )}
    </div>
  );
}

/** Bubble color classes per (theme, channel, direction). */
function bubbleClasses(
  channel: ConversationChannel,
  isOutbound: boolean,
  theme: ConversationTheme
): string {
  if (theme === "native") {
    if (channel === "whatsapp") {
      return isOutbound
        ? "rounded-br-sm bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-white"
        : "rounded-bl-sm bg-white text-[#111b21] ring-1 ring-black/5 dark:bg-[#202c33] dark:text-[#e9edef] dark:ring-0";
    }
    if (channel === "messenger") {
      // Messenger → blue outbound bubble
      return isOutbound
        ? "rounded-br-sm bg-[#0084ff] text-white"
        : "rounded-bl-sm bg-[#e9e9eb] text-black dark:bg-[#3b3b3d] dark:text-white";
    }
    if (channel === "instagram") {
      // Instagram → purple/gradient outbound bubble
      return isOutbound
        ? "rounded-br-sm bg-gradient-to-br from-[#a033ff] via-[#ff5280] to-[#ff7061] text-white"
        : "rounded-bl-sm bg-[#efefef] text-black dark:bg-[#3b3b3d] dark:text-white";
    }
    if (channel === "web-chat") {
      // Web Chat → sky outbound bubble
      return isOutbound
        ? "rounded-br-sm bg-sky-500 text-white"
        : "rounded-bl-sm bg-[#e9e9eb] text-black dark:bg-[#3b3b3d] dark:text-white";
    }
    // SMS → iMessage palette
    return isOutbound
      ? "rounded-br-sm bg-[#007aff] text-white"
      : "rounded-bl-sm bg-[#e9e9eb] text-black dark:bg-[#3b3b3d] dark:text-white";
  }
  // Standard / brand
  return isOutbound
    ? "rounded-br-sm bg-primary text-primary-foreground"
    : "rounded-bl-sm bg-muted";
}

function ChannelBubble({
  message,
  theme,
  onEmailReply,
}: {
  message: ChannelMessage;
  onEmailReply?: (message: EmailMessageDoc) => void;
  theme: ConversationTheme;
}) {
  const isOutbound = message.direction === "outbound";
  const ts = toDate(message.createdAt);
  const native = theme === "native";
  const channelLabel = CHANNEL_LABEL[message.channel] ?? message.channel;
  // Native: color conveys the channel, so drop the text chip; WhatsApp outbound
  // gets the recognizable double-tick (cosmetic "delivered" cue).
  const showTicks =
    native &&
    isOutbound &&
    message.channel === "whatsapp" &&
    message.status !== "failed";

  return (
    <div
      className={cn("flex flex-col", isOutbound ? "items-end" : "items-start")}
    >
      <div
        className={cn(
          "max-w-[78%] rounded-2xl px-3 py-2 text-sm",
          bubbleClasses(message.channel, isOutbound, theme),
          message.status === "failed" && "ring-destructive ring-2"
        )}
      >
        {"subject" in message && (
          <div className="mb-2 space-y-1">
            <p className="font-semibold">{message.subject || "(no subject)"}</p>
            <p className="text-xs break-all">
              From: {message.from}
              <br />
              To: {message.to.join(", ")}
            </p>
          </div>
        )}
        <p className="break-words whitespace-pre-wrap">{message.body}</p>
        {"attachments" in message && message.attachments.length > 0 && (
          <div className="mt-2 border-t pt-2 text-xs">
            <p>Attachments (metadata only; open originals in your mailbox)</p>
            {message.attachments.map((file, i) => (
              <p key={i}>
                {file.filename} · {file.contentType} · {file.size} bytes
              </p>
            ))}
          </div>
        )}
      </div>
      <div className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[10px]">
        {(!native || message.channel === "email") && (
          <span
            className={cn(
              "rounded-full px-1.5 font-medium",
              CHANNEL_CHIP[message.channel] ?? CHANNEL_CHIP.sms
            )}
          >
            {channelLabel}
          </span>
        )}
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
        {"subject" in message && (
          <span>· {isOutbound ? "sent" : "received"}</span>
        )}
        {"subject" in message && onEmailReply && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onEmailReply(message)}
          >
            Reply
          </Button>
        )}
        {showTicks && (
          <CheckCheck className="h-3 w-3 text-sky-500" aria-label="delivered" />
        )}
        {message.status === "failed" && (
          <span className="text-destructive">· failed</span>
        )}
      </div>
    </div>
  );
}
