import type { Note } from "@/types/contacts";
import type { ScheduledMessageView } from "@/types/scheduled-messages";

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
  | { kind: "note"; key: string; at: number; note: Note }
  | { kind: "scheduled"; key: string; at: number; scheduled: ScheduledMessageView };

/** Same-millisecond order: what was said, then the note on it, then what is booked. */
const KIND_RANK = { message: 0, note: 1, scheduled: 2 } as const;

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
 *
 * Scheduled messages (SP2 T5) sit at their `sendAt`: a pending one is in the
 * future, so it lands after everything already said; a failed one stays where
 * it would have gone out.
 */
export function mergeThreadItems<
  M extends { id: string; channel: string; createdAt?: unknown },
>(
  messages: M[],
  notes: Note[],
  scheduled: ScheduledMessageView[] = []
): ThreadItem<M>[] {
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
    ...scheduled.map((s) => ({
      kind: "scheduled" as const,
      key: `scheduled:${s.id}`,
      at: Date.parse(s.sendAt) || 0,
      scheduled: s,
    })),
  ];
  items.sort((a, b) => a.at - b.at || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  return items;
}
