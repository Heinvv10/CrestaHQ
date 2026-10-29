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
/** Rotating /64s inside one /48 (one customer's allocation) share this wider cap. */
const BOOKINGS_PER_IPV6_48 = BOOKINGS_PER_IP * 4;
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

/**
 * A bucket key from its parts, JSON-encoded so no id can reach into the next
 * part. Over-long parts are cut, which can only merge buckets (stricter).
 */
function bucketKey(...parts: string[]): string {
  return JSON.stringify(parts.map((p) => p.slice(0, MAX_KEY_PART)));
}

/**
 * A visitor IP's bucket prefixes: `host` is the IPv4 address (IPv4-mapped
 * IPv6 included) or the IPv6 /64, one host's usual allocation; `wide` is the
 * IPv6 /48, null for IPv4. A zone id is dropped. They are parsed forms, so
 * their length is bounded whatever the header held. Null = no usable IP
 * ("unknown", empty, garbage, not a string).
 */
export function ipPrefixes(raw: unknown): { host: string; wide: string | null } | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!ipaddr.isValid(v)) return null;
  const addr = ipaddr.process(v);
  if (addr.kind() === "ipv4") return { host: addr.toString(), wide: null };
  const groups = (addr as ipaddr.IPv6).toNormalizedString().split(":");
  return {
    host: `${groups.slice(0, 4).join(":")}::/64`,
    wide: `${groups.slice(0, 3).join(":")}::/48`,
  };
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
  const sa = input.subAccountId;
  const keys: CapKey[] = [
    { key: bucketKey("conv", sa, input.conversationKey), limit: BOOKINGS_PER_CONVERSATION, scope: "chat" },
  ];
  // IP buckets are per sub-account: one visitor (or one busy ISP range)
  // must not use up another workspace's booking.
  if (input.visitor) {
    const ip = ipPrefixes(input.visitor.ip);
    if (!ip) {
      keys.push({ key: bucketKey("noip", sa), limit: NO_IP_BOOKINGS_PER_SUB_ACCOUNT, scope: "visitor" });
    } else {
      keys.push({ key: bucketKey("ip", sa, ip.host), limit: BOOKINGS_PER_IP, scope: "visitor" });
      if (ip.wide) {
        keys.push({ key: bucketKey("ip48", sa, ip.wide), limit: BOOKINGS_PER_IPV6_48, scope: "visitor" });
      }
    }
  }
  keys.push({ key: bucketKey("sa", sa), limit: BOOKINGS_PER_SUB_ACCOUNT, scope: "workspace" });
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
      key: bucketKey("chg", subAccountId, conversationKey),
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
