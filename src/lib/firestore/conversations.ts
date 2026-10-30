import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type {
  ConversationBotMode,
  ConversationDoc,
} from "@/types/conversations";

import {
  territoryQueryPlan,
  NOOP_UNSUB,
} from "@/lib/firestore/territory-query";

const CONVERSATIONS = "conversations";

/**
 * Live list of conversations for a sub-account. Filters on subAccountId only
 * and sorts by lastMessageAt client-side — same convention as
 * subscribeToContacts, which avoids a composite index.
 *
 * `waitForServer` holds the callback until the server has answered. Without
 * it the first snapshot can come from the in-memory cache and hold only the
 * docs another query loaded (the inbox preview, the unread badge) — a
 * partial inbox shown as complete.
 */
export function subscribeToConversations(
  subAccountId: string,
  callback: (conversations: ConversationDoc[]) => void,
  onError?: (err: Error) => void,
  territoryFilter?: string[] | null,
  opts: { waitForServer?: boolean } = {}
): Unsubscribe {
  const plan = territoryQueryPlan(territoryFilter);
  if (plan.mode === "empty") {
    callback([]);
    return NOOP_UNSUB;
  }
  const q = query(
    collection(getFirebaseDb(), CONVERSATIONS),
    where("subAccountId", "==", subAccountId),
    ...(plan.mode === "in" ? [plan.constraint] : [])
  );
  let serverAnswered = false;
  return onSnapshot(
    q,
    // A warm, complete cache makes the server's confirmation metadata-only;
    // without this it would never fire.
    { includeMetadataChanges: opts.waitForServer === true },
    (snap) => {
      if (opts.waitForServer) {
        if (snap.metadata.fromCache && !serverAnswered) return;
        if (serverAnswered && snap.docChanges().length === 0) return;
        serverAnswered = true;
      }
      const rows = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<ConversationDoc, "id">),
      }));
      rows.sort(
        (a, b) => toMillis(b.lastMessageAt) - toMillis(a.lastMessageAt)
      );
      callback(rows);
    },
    (err) => onError?.(err)
  );
}

/**
 * Live count of conversations with unread inbound messages. Queries only the
 * unread ones: the badge used to subscribe to the whole inbox (~2 MB on a
 * 5,000-conversation sub-account) on every dashboard page just to count.
 * Needs the (subAccountId, unreadCount) and (subAccountId, territoryId,
 * unreadCount) indexes. A doc with no `unreadCount` is not unread.
 */
export function subscribeToUnreadConversationCount(
  subAccountId: string,
  callback: (count: number) => void,
  onError?: (err: Error) => void,
  territoryFilter?: string[] | null
): Unsubscribe {
  const plan = territoryQueryPlan(territoryFilter);
  if (plan.mode === "empty") {
    callback(0);
    return NOOP_UNSUB;
  }
  const q = query(
    collection(getFirebaseDb(), CONVERSATIONS),
    where("subAccountId", "==", subAccountId),
    ...(plan.mode === "in" ? [plan.constraint] : []),
    where("unreadCount", ">", 0)
  );
  return onSnapshot(
    q,
    (snap) => callback(snap.size),
    (err) => onError?.(err)
  );
}

/**
 * The `count` most recently active conversations, one-shot — a first paint
 * for the inbox while the full list is still downloading. Needs the
 * (subAccountId, lastMessageAt desc) index; without it this rejects and
 * callers show no preview. A doc with no `lastMessageAt` is left out.
 */
export async function fetchNewestConversations(
  subAccountId: string,
  count: number
): Promise<ConversationDoc[]> {
  const snap = await getDocs(
    query(
      collection(getFirebaseDb(), CONVERSATIONS),
      where("subAccountId", "==", subAccountId),
      orderBy("lastMessageAt", "desc"),
      limit(count)
    )
  );
  return snap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<ConversationDoc, "id">),
  }));
}

/** Live single conversation (doc id == contactId). */
export function subscribeToConversation(
  contactId: string,
  callback: (conversation: ConversationDoc | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  return onSnapshot(
    doc(getFirebaseDb(), CONVERSATIONS, contactId),
    (snap) => {
      callback(
        snap.exists()
          ? { id: snap.id, ...(snap.data() as Omit<ConversationDoc, "id">) }
          : null
      );
    },
    (err) => onError?.(err)
  );
}

/**
 * Reset the conversation's unread counter. Called when an operator opens the
 * thread. Best-effort — a blip here just leaves a stale badge, never blocks.
 * Rules permit clients to update only the operator-facing field set.
 */
export async function markConversationRead(contactId: string): Promise<void> {
  try {
    await updateDoc(doc(getFirebaseDb(), CONVERSATIONS, contactId), {
      unreadCount: 0,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("[conversations] mark-read failed", err);
  }
}

/**
 * Put a read conversation back in the Unread tab. Sets the counter to 1 — the
 * real inbound count is gone once it was zeroed, and the badge only needs to
 * be non-zero. The thread page marks read only when a thread is OPENED, so
 * this survives staying on the thread.
 */
export async function markConversationUnread(
  conversationId: string
): Promise<void> {
  await updateDoc(doc(getFirebaseDb(), CONVERSATIONS, conversationId), {
    unreadCount: 1,
    updatedAt: serverTimestamp(),
  });
}

/** Star / unstar a conversation (shared across the sub-account's users). */
export async function setConversationStarred(
  conversationId: string,
  starred: boolean
): Promise<void> {
  await updateDoc(doc(getFirebaseDb(), CONVERSATIONS, conversationId), {
    starred,
    updatedAt: serverTimestamp(),
  });
}

/** Set the per-conversation AI mode (off / suggest / auto). */
export async function setConversationBotMode(
  contactId: string,
  mode: ConversationBotMode
): Promise<void> {
  try {
    await updateDoc(doc(getFirebaseDb(), CONVERSATIONS, contactId), {
      botMode: mode,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("[conversations] set bot mode failed", err);
  }
}

/** Clear a bot pause so the AI can resume replying on this conversation. */
export async function resumeBot(contactId: string): Promise<void> {
  try {
    await updateDoc(doc(getFirebaseDb(), CONVERSATIONS, contactId), {
      botPausedUntil: null,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("[conversations] resume bot failed", err);
  }
}

/** Discard a pending suggest-mode draft without sending it. */
export async function discardConversationDraft(
  contactId: string
): Promise<void> {
  try {
    await updateDoc(doc(getFirebaseDb(), CONVERSATIONS, contactId), {
      pendingDraft: null,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("[conversations] discard draft failed", err);
  }
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
