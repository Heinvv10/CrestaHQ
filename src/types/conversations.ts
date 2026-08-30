import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Unified inbox index — one doc per contact at `conversations/{contactId}`.
 *
 * This is a thin INDEX, not a message store. The actual messages stay in their
 * existing per-contact subcollections (`contacts/{id}/messages` for SMS,
 * `contacts/{id}/whatsappMessages` for WhatsApp); the inbox detail view merges
 * those at read time. This doc only holds the denormalized state the inbox LIST
 * needs (last-message preview, unread count, status) plus the per-conversation
 * AI controls reserved for a later phase (`botMode`, `botPausedUntil`).
 *
 * Written server-side by `lib/server/conversations-service.ts` on every inbound
 * + outbound message. Doc id == contactId (1:1), so upserts need no lookup and
 * the detail page can read the contact's message subcollections directly.
 *
 * Only created when a real message row is written — i.e. dedicated-Twilio SMS,
 * a configured WhatsApp sender, or (beta) a connected Meta inbox. Shared-sender
 * SMS (no message rows) produces no conversation, consistent with the
 * per-contact threads. Message subcollections by channel:
 *   sms → contacts/{id}/messages, whatsapp → contacts/{id}/whatsappMessages,
 *   messenger + instagram → contacts/{id}/metaMessages (channel-discriminated).
 */

/**
 * `messenger` + `instagram` are the BETA Meta channels — gated by the agency
 * `metaInboxEnabledByAgency` flag, so they only ever appear once that's on.
 *
 * `web-chat` is the odd one out: unlike the other four (which are all
 * contact-first and keyed on `contactId`), a web-chat thread starts as an
 * ANONYMOUS browser session with no contact. Its conversation row is keyed on
 * the session instead (doc id `web_{sessionId}`, see `webChatConversationId`),
 * with `contactId` null until the bot captures identity. The messages live in
 * `subAccounts/{id}/webChatSessions/{sessionId}/messages`, NOT under a contact.
 */
export type ConversationChannel =
  | "sms"
  | "whatsapp"
  | "messenger"
  | "instagram"
  | "web-chat";

/**
 * Prefix that marks a session-keyed (web-chat) conversation doc. A Firestore
 * auto-id contactId never starts with this, so the prefix cleanly discriminates
 * anonymous/web-chat rows from the contact-keyed rows every other channel uses.
 */
export const WEB_CHAT_CONVO_PREFIX = "web_";

/** Build the conversation doc id for a web-chat session. */
export function webChatConversationId(sessionId: string): string {
  return `${WEB_CHAT_CONVO_PREFIX}${sessionId}`;
}

/**
 * If `conversationId` is a web-chat (session-keyed) doc id, return the bare
 * sessionId; otherwise null. Lets the inbox detect web-chat threads without a
 * doc read (the route param is the doc id).
 */
export function parseWebChatConversationId(conversationId: string): string | null {
  return conversationId.startsWith(WEB_CHAT_CONVO_PREFIX)
    ? conversationId.slice(WEB_CHAT_CONVO_PREFIX.length)
    : null;
}

export type ConversationStatus = "open" | "closed" | "snoozed";

/**
 * Per-conversation AI mode:
 *  - "auto"    — bot replies automatically (default).
 *  - "suggest" — bot drafts a reply into `pendingDraft`; a human approves/edits.
 *  - "off"     — bot stays silent on this conversation.
 */
export type ConversationBotMode = "off" | "suggest" | "auto";

/**
 * A bot-generated reply awaiting human approval (suggest mode). Cleared when
 * approved (a human send clears it server-side) or discarded.
 */
export interface ConversationDraft {
  body: string;
  channel: ConversationChannel;
  model: string;
  tokens: number;
  createdAt: Timestamp | FieldValue | null;
}

export interface ConversationDoc {
  id: string;
  /**
   * The linked contact. For every channel except web-chat this == the doc id.
   * Web-chat rows start anonymous (`null`) and get a contactId stamped when the
   * bot captures identity — the doc id stays the session key either way.
   */
  contactId: string | null;
  /**
   * Set ONLY on web-chat rows — the session whose transcript lives in
   * `subAccounts/{id}/webChatSessions/{sessionId}/messages`. Null/absent for
   * the contact-keyed channels. Its presence is how the inbox knows to read
   * the session subcollection + route replies through the web-chat send path.
   */
  sessionId?: string | null;
  /**
   * Human label for a still-anonymous web-chat visitor (e.g.
   * "Web visitor · pricing page"). Used for the list/thread title until a
   * contact is captured; null for contact-backed rows (contactName wins).
   */
  visitorLabel?: string | null;
  /** Tenancy keys (every list query filters on subAccountId). */
  subAccountId: string;
  agencyId: string;
  /** Denormalized so the list renders without N contact reads. */
  contactName: string;
  contactPhone: string | null;
  /** Channels this thread has carried, e.g. ["sms","whatsapp"]. */
  channelsSeen: ConversationChannel[];
  /** Channel of the most recent message — the composer's default. */
  lastChannel: ConversationChannel;
  lastDirection: "inbound" | "outbound";
  /** First ~120 chars of the most recent message body. */
  lastMessagePreview: string;
  /** Sort key for the inbox list (newest first). */
  lastMessageAt: Timestamp | FieldValue | null;
  /** Incremented server-side on inbound; reset to 0 client-side on open. */
  unreadCount: number;
  status: ConversationStatus;
  assigneeUid: string | null;
  /** AI mode for this conversation. Default "auto". */
  botMode: ConversationBotMode;
  /** When set + in the future, the bot stays quiet (human took over). */
  botPausedUntil: Timestamp | FieldValue | null;
  /** Suggest-mode draft awaiting human approval; null when none. */
  pendingDraft: ConversationDraft | null;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}
