import "server-only";

import { GLOBAL_TERRITORY_ID } from "@/types";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  contactMirror,
  type ConversationMirror,
} from "@/lib/server/conversation-mirror";
import {
  fireWorkflowTrigger,
  resumeWaitingRunsOnReply,
} from "@/lib/workflows/engine";
import type {
  ConversationBotMode,
  ConversationChannel,
} from "@/types/conversations";

/**
 * How long a manual (human) reply pauses the bot on that conversation. The
 * pause auto-expires; the operator can also Resume it from the inbox. Keeps the
 * AI from jumping back into a thread a human is actively handling.
 */
const PAUSE_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Server-side write for the unified-inbox index. Called right after every
 * message-row write (SMS/WhatsApp, inbound + outbound). Best-effort: a failure
 * here must never break the underlying send/receive, so every call is wrapped
 * and the originating route `void`s it or ignores the resolved promise.
 *
 * Doc id == contactId (one conversation per contact). A get-or-create
 * transaction stamps the immutable fields once (createdAt, status, botMode),
 * then merges the rolling state (preview, lastChannel, lastMessageAt) and, for
 * inbound, increments unreadCount.
 */

const PREVIEW_MAX = 120;

export interface UpsertConversationInput {
  /**
   * The linked contact, or null for an anonymous web-chat session that hasn't
   * captured identity yet. When null, `conversationKey` MUST be provided.
   */
  contactId: string | null;
  /**
   * Overrides the conversation doc id. Defaults to `contactId` (the 1:1
   * contact-keyed model every non-web channel uses). Web chat passes
   * `webChatConversationId(sessionId)` so an anonymous thread has a stable key
   * before any contact exists — and keeps that key after capture (doc ids are
   * immutable). Absent → doc id == contactId, i.e. zero change for SMS etc.
   */
  conversationKey?: string;
  /** Web-chat only: the session whose transcript backs this row. */
  sessionId?: string | null;
  /** Web-chat only: display label while still anonymous. */
  visitorLabel?: string | null;
  subAccountId: string;
  agencyId: string;
  /** Denormalized onto the conversation for the list view. */
  contactName: string;
  contactPhone: string | null;
  channel: ConversationChannel;
  direction: "inbound" | "outbound";
  body: string;
  /**
   * True when this is a HUMAN operator's outbound reply (the comms send
   * routes). Pauses the bot for PAUSE_WINDOW_MS, marks the thread read, and
   * clears any pending AI draft. The bot's own replies pass this false.
   */
  pauseBot?: boolean;
  /** The inbound message was a WhatsApp button tap (it carried a payload). */
  buttonTap?: boolean;
}

function toMillis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const ts = v as { toMillis?: () => number } | null | undefined;
  return typeof ts?.toMillis === "function" ? ts.toMillis() : null;
}

/**
 * The authoritative contact fields this conversation copies: its territory
 * (access control) and the SP2 mirror (owner + email — see
 * lib/server/conversation-mirror.ts). Read together in the transaction, so one
 * contact read serves all three and the mirror is re-stamped on every message
 * — which is what makes it self-healing.
 *
 * An anonymous web-chat row has no contact: global territory, empty mirror.
 */
async function contactDenorm(
  tx: FirebaseFirestore.Transaction,
  input: { contactId: string | null; subAccountId: string; agencyId: string }
): Promise<{ territoryId: string | null; mirror: ConversationMirror | null }> {
  if (!input.contactId)
    return { territoryId: GLOBAL_TERRITORY_ID, mirror: null };
  const contact = (
    await tx.get(getAdminDb().doc(`contacts/${input.contactId}`))
  ).data();
  if (
    !contact ||
    contact.subAccountId !== input.subAccountId ||
    contact.agencyId !== input.agencyId
  )
    throw new Error("Conversation contact tenant mismatch.");
  return {
    territoryId: contact.territoryId ?? null,
    mirror: contactMirror(contact),
  };
}

export async function upsertConversationForMessage(
  input: UpsertConversationInput
): Promise<void> {
  // When this message arrived — a late-tap flag must not land over a human
  // reply made after it (see below).
  const receivedAt = Date.now();
  try {
    const db = getAdminDb();
    // Doc id: an explicit conversationKey (web chat's session key) wins;
    // otherwise the contact-keyed 1:1 model. One of the two is always present.
    const docId = input.conversationKey ?? input.contactId;
    if (!docId) {
      console.warn("[conversations/upsert] no contactId or conversationKey");
      return;
    }
    const ref = db.collection("conversations").doc(docId);
    const preview =
      input.body.length > PREVIEW_MAX
        ? `${input.body.slice(0, PREVIEW_MAX)}…`
        : input.body;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const { territoryId, mirror } = await contactDenorm(tx, input);

      const patch: Record<string, unknown> = {
        territoryId,
        // Owner + email mirrored off the contact on every message (SP2 T1/I9).
        // Only when there IS a contact — an anonymous web-chat row has nobody
        // to mirror, and stamping null would fight nothing.
        ...(mirror ?? {}),
        contactId: input.contactId,
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        channelsSeen: FieldValue.arrayUnion(input.channel),
        // Web-chat identity fields — only written when supplied, so
        // contact-keyed rows never gain these keys.
        ...(input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : {}),
        ...(input.visitorLabel !== undefined
          ? { visitorLabel: input.visitorLabel }
          : {}),
        lastChannel: input.channel,
        lastDirection: input.direction,
        lastMessagePreview: preview,
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (input.direction === "inbound") {
        // increment() on a missing field initializes it to 1.
        patch.unreadCount = FieldValue.increment(1);
      }

      if (input.pauseBot) {
        // A human took over: pause the bot, mark read, drop any stale draft.
        patch.botPausedUntil = new Date(Date.now() + PAUSE_WINDOW_MS);
        patch.unreadCount = 0;
        patch.pendingDraft = null;
        patch.lateButtonTap = null;
        patch.lastHumanReplyAt = FieldValue.serverTimestamp();
      }

      if (!snap.exists) {
        // Stamp immutable defaults once.
        patch.createdAt = FieldValue.serverTimestamp();
        patch.status = "open";
        // assigneeUid / contactEmail come from the mirror above; an anonymous
        // web-chat row has no contact, so it starts empty.
        if (!mirror) {
          patch.assigneeUid = null;
          patch.contactEmail = null;
        }
        patch.botMode = "auto"; // reserved for Phase 2
        patch.botPausedUntil = null;
        // First-ever message is outbound → no unread yet.
        if (input.direction !== "inbound") patch.unreadCount = 0;
      }

      tx.set(ref, patch, { merge: true });
    });

    // message.received — every inbound message across every channel flows
    // through this upsert, making it the single emit point for the
    // Conversations webhook category + the speed-to-lead push. Emitted
    // AFTER the index write succeeds and self-guarded, so it can never
    // break the inbound webhook that called us. Always live — inbound
    // messages originate from providers, not test-mode API calls.
    // The message.received webhook + workflow side-effects are all
    // contact-keyed (push routing, wait_for_reply resolution, and
    // trigger enrollment all need a contactId). An anonymous web-chat
    // session has none yet, so we skip them until capture stamps a
    // contactId — at which point later messages fire them normally.
    // For every other channel contactId is always set, so this guard is
    // a no-op and existing behavior is byte-for-byte unchanged.
    if (input.direction === "inbound" && input.contactId) {
      const contactId = input.contactId;
      void emitWebhookEvent({
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        mode: "live",
        type: "message.received",
        payload: {
          message: {
            object: "message",
            contact_id: contactId,
            contact_name: input.contactName,
            channel: input.channel,
            preview: preview,
          },
        },
      });
      // A reply resolves any workflow run parked on a wait_for_reply node.
      // Self-guarded fire-and-forget — same contract as the webhook emit.
      const resumed = resumeWaitingRunsOnReply({
        subAccountId: input.subAccountId,
        contactId,
        channel: input.channel,
        // The body, so a downstream if_else can branch on the answer itself.
        // This is the only place it is available — the run has no other route
        // to what the contact actually said.
        text: input.body,
      });
      // A tap always answers an earlier button message. If no run was waiting
      // for it (the wait had timed out), no automation will act on it — flag
      // the thread so a human does. A finished run is never resumed. If ANY
      // other run of this contact was waiting, the reply went to it and no
      // flag is raised.
      //
      // The flag lands after the fire-and-forget resume settles, so a human
      // may already have replied (and cleared it). The write is skipped when a
      // HUMAN replied after this message arrived — `lastHumanReplyAt`, set only
      // on the operator-reply path. An AI or workflow send in that window does
      // not suppress it: an automated reply is not a human handling the tap.
      void Promise.resolve(resumed)
        .then(async (n) => {
          if (!input.buttonTap || n !== 0) return;
          await db.runTransaction(async (tx) => {
            const current = (await tx.get(ref)).data();
            if (!current) return;
            const humanAt = toMillis(current.lastHumanReplyAt);
            if (humanAt !== null && humanAt >= receivedAt) return;
            tx.update(ref, {
              lateButtonTap: { text: preview, at: FieldValue.serverTimestamp() },
            });
          });
        })
        .catch((err) => console.warn("[conversations/upsert] late-tap flag failed", err));
      // And enrolls the contact in message.received workflows (the trigger's
      // optional channel filter narrows inside fireWorkflowTrigger).
      void fireWorkflowTrigger({
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        type: "message.received",
        contactId,
        context: { channel: input.channel },
      });
    }
  } catch (err) {
    console.warn("[conversations/upsert] failed", err);
  }
}

/**
 * Read the AI controls the orchestrator needs to decide whether/how to reply.
 * Defaults to "auto" + not-paused when the doc or fields are missing, so legacy
 * conversations keep auto-replying exactly as before.
 *
 * `conversationId` is the conversation DOC id: the contactId for the
 * contact-keyed channels, or `webChatConversationId(sessionId)` for web chat.
 */
export async function getConversationControls(
  conversationId: string
): Promise<{ botMode: ConversationBotMode; botPausedUntilMs: number | null }> {
  try {
    const snap = await getAdminDb()
      .collection("conversations")
      .doc(conversationId)
      .get();
    if (!snap.exists) return { botMode: "auto", botPausedUntilMs: null };
    const d = snap.data() ?? {};
    const botMode = (d.botMode as ConversationBotMode) ?? "auto";
    const bp = d.botPausedUntil as
      | { toMillis?: () => number }
      | null
      | undefined;
    const botPausedUntilMs =
      bp && typeof bp.toMillis === "function" ? bp.toMillis() : null;
    return { botMode, botPausedUntilMs };
  } catch (err) {
    console.warn("[conversations/controls] read failed", err);
    return { botMode: "auto", botPausedUntilMs: null };
  }
}

/**
 * Write a suggest-mode draft onto the conversation for a human to approve.
 * The conversation already exists (the inbound upsert ran first), but we carry
 * the tenancy + denorm fields anyway for safety.
 */
export async function setConversationDraft(input: {
  contactId: string | null;
  /** Doc id override — web chat passes its session key (see upsert). */
  conversationKey?: string;
  sessionId?: string | null;
  visitorLabel?: string | null;
  subAccountId: string;
  agencyId: string;
  contactName: string;
  contactPhone: string | null;
  channel: ConversationChannel;
  body: string;
  model: string;
  tokens: number;
}): Promise<void> {
  try {
    const docId = input.conversationKey ?? input.contactId;
    if (!docId) return;
    const db = getAdminDb();
    await db.runTransaction(async (tx) => {
      const { territoryId, mirror } = await contactDenorm(tx, input);
      tx.set(
        db.doc(`conversations/${docId}`),
        {
          territoryId,
          ...(mirror ?? {}),
          contactId: input.contactId,
          subAccountId: input.subAccountId,
          agencyId: input.agencyId,
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          ...(input.sessionId !== undefined
            ? { sessionId: input.sessionId }
            : {}),
          ...(input.visitorLabel !== undefined
            ? { visitorLabel: input.visitorLabel }
            : {}),
          pendingDraft: {
            body: input.body,
            channel: input.channel,
            model: input.model,
            tokens: input.tokens,
            createdAt: FieldValue.serverTimestamp(),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
  } catch (err) {
    console.warn("[conversations/draft] write failed", err);
  }
}
