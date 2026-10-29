import "server-only";

import ipaddr from "ipaddr.js";

/**
 * In-memory caps on what the AI can do to the calendar, per rolling day.
 * Anonymous web visitors and anyone who can text the number can reach the
 * booking tools, so cap bookings per IP, per conversation and per workspace,
 * and cap cancels/reschedules per conversation. Per-instance on serverless,
 * so best-effort, like the other rate limits.
 *
 * reserveBooking / reserveChange check and count in one synchronous step, so
 * two concurrent turns can't both pass the check. Release a reservation only
 * when the engine says nothing happened (slot_taken, invalid_slot, refused);
 * after an error or a throw the outcome is unknown and the reservation stands.
 */

const BOOKINGS_PER_IP = 5;
const BOOKINGS_PER_CONVERSATION = 2;
const BOOKINGS_PER_SUB_ACCOUNT = 50;
/** Web visitors whose IP didn't come through share one stricter bucket per workspace. */
const NO_IP_BOOKINGS_PER_SUB_ACCOUNT = 10;
const CHANGES_PER_CONVERSATION = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_PART = 128;

const buckets = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  return (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
}

function push(key: string, now: number): void {
  buckets.set(key, [...recent(key, now), now]);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= WINDOW_MS)) buckets.delete(k);
    }
  }
}

function unpush(key: string, stamp: number): void {
  const list = buckets.get(key);
  const i = list?.indexOf(stamp) ?? -1;
  if (list && i >= 0) list.splice(i, 1);
}

/** Over-long ids are cut, which can only merge buckets (stricter), never split them. */
function part(value: string): string {
  return value.slice(0, MAX_KEY_PART);
}

/**
 * The bucket for an IP: IPv4 (and IPv4-mapped IPv6) as a dotted quad, IPv6
 * as its /64, since one host usually holds a whole /64 (a zone id is
 * dropped). The bucket is the parsed form, so its length is bounded whatever
 * the header held. Null = no usable IP ("unknown", empty, garbage).
 */
export function ipBucket(raw: string | null): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!ipaddr.isValid(v)) return null;
  const addr = ipaddr.process(v);
  if (addr.kind() === "ipv4") return `ip:${addr.toString()}`;
  const head = (addr as ipaddr.IPv6).toNormalizedString().split(":").slice(0, 4);
  return `ip6:${head.join(":")}::/64`;
}

export type BookingCapResult = "ok" | "chat" | "visitor" | "workspace";
type CapScope = Exclude<BookingCapResult, "ok">;

export interface BookingCapInput {
  subAccountId: string;
  /** Identifies the chat (session id or contact id). */
  conversationKey: string;
  /**
   * A web visitor (their IP, null when it didn't come through), or null for a
   * channel without one (phone, messaging), where the conversation key is the
   * person.
   */
  visitor: { ip: string | null } | null;
}

interface CapKey {
  key: string;
  limit: number;
  scope: CapScope;
}

function bookingKeys(input: BookingCapInput): CapKey[] {
  const sa = part(input.subAccountId);
  const keys: CapKey[] = [
    { key: `conv:${sa}:${part(input.conversationKey)}`, limit: BOOKINGS_PER_CONVERSATION, scope: "chat" },
  ];
  if (input.visitor) {
    const ip = ipBucket(input.visitor.ip);
    keys.push(
      ip
        ? { key: ip, limit: BOOKINGS_PER_IP, scope: "visitor" }
        : { key: `noip:${sa}`, limit: NO_IP_BOOKINGS_PER_SUB_ACCOUNT, scope: "visitor" },
    );
  }
  keys.push({ key: `sa:${sa}`, limit: BOOKINGS_PER_SUB_ACCOUNT, scope: "workspace" });
  return keys;
}

/** Read-only, for prompt state ("this chat has hit its limit"). Booking goes through reserveBooking. */
export function peekBookingCaps(input: BookingCapInput): BookingCapResult {
  const now = Date.now();
  return bookingKeys(input).find((k) => recent(k.key, now).length >= k.limit)?.scope ?? "ok";
}

export type CapReservation = { ok: true; release: () => void } | { ok: false; scope: CapScope };

function reserve(keys: CapKey[]): CapReservation {
  const now = Date.now();
  const full = keys.find((k) => recent(k.key, now).length >= k.limit);
  if (full) return { ok: false, scope: full.scope };
  for (const k of keys) push(k.key, now);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      for (const k of keys) unpush(k.key, now);
    },
  };
}

/** Checks every booking cap and, when all pass, counts the booking. */
export function reserveBooking(input: BookingCapInput): CapReservation {
  return reserve(bookingKeys(input));
}

/** The same for a cancel or reschedule (refusal scope is always "chat"). */
export function reserveChange(subAccountId: string, conversationKey: string): CapReservation {
  return reserve([
    {
      key: `chg:${part(subAccountId)}:${part(conversationKey)}`,
      limit: CHANGES_PER_CONVERSATION,
      scope: "chat",
    },
  ]);
}

/** Tracked keys, for the prune test. */
export function capBucketCount(): number {
  return buckets.size;
}

export const MAX_BOOKINGS_PER_CONVERSATION = BOOKINGS_PER_CONVERSATION;
