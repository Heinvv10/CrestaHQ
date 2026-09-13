import type { Note } from "@/types/contacts";

/**
 * Time-ordering for the conversation thread (SP2 T2). The thread renders two
 * kinds of row — sent/received messages and internal notes — in one stream, so
 * an operator reads the note next to the message it is about.
 *
 * Notes are contact notes (`contacts/{id}/notes`), the same rows the contact
 * timeline shows; the ones written from the composer carry
 * `source: "conversation"`. Both kinds are ordered by their own timestamp,
 * oldest first, matching the message-only order this replaced.
 */

export type ThreadItem<M> =
  | { kind: "message"; key: string; at: number; message: M }
  | { kind: "note"; key: string; at: number; note: Note };

/** Milliseconds for a Firestore Timestamp / Date / null. 0 when unknown. */
export function itemMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}

/**
 * Merge messages and notes into one oldest-first stream. A note and a message
 * written in the same millisecond put the message first — a note is almost
 * always a comment ON what just arrived.
 */
export function mergeThreadItems<
  M extends { id: string; channel: string; createdAt?: unknown },
>(messages: M[], notes: Note[]): ThreadItem<M>[] {
  // Notes go in FIRST: Array.sort is stable, so building messages first would
  // put a same-millisecond message ahead of a note without any tie-break, and
  // the tie-break below would be untested decoration.
  const items: ThreadItem<M>[] = [
    ...notes.map((n) => ({
      kind: "note" as const,
      key: `note:${n.id}`,
      // A note the operator just saved has no server time yet (the local
      // snapshot carries a null serverTimestamp). It is the newest row, not
      // the oldest — without this it would jump to the top of the thread.
      at: n.createdAt ? itemMillis(n.createdAt) : Number.POSITIVE_INFINITY,
      note: n,
    })),
    ...messages.map((m) => ({
      kind: "message" as const,
      key: `${m.channel}:${m.id}`,
      at: itemMillis(m.createdAt),
      message: m,
    })),
  ];
  items.sort(
    (a, b) =>
      a.at - b.at ||
      (a.kind === b.kind ? 0 : a.kind === "message" ? -1 : 1)
  );
  return items;
}
