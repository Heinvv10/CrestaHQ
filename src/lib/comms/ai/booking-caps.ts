import "server-only";

/**
 * In-memory caps on what the AI can do to the calendar, per rolling day.
 * Anonymous web visitors and anyone who can text the number can reach the
 * booking tools, so cap bookings per IP, per conversation and per workspace,
 * and cap cancels/reschedules per conversation. Per-instance on serverless,
 * so best-effort, like the other rate limits.
 */

const BOOKINGS_PER_IP = 5;
const BOOKINGS_PER_CONVERSATION = 2;
const BOOKINGS_PER_SUB_ACCOUNT = 50;
const CHANGES_PER_CONVERSATION = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;

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

/** "unknown" is the fallback when no IP header came through; it isn't one visitor. */
function ipKey(ip: string | null): string | null {
  return ip && ip !== "unknown" ? `ip:${ip}` : null;
}

export type BookingCapResult = "ok" | "chat" | "visitor" | "workspace";

/** `conversationKey` identifies the chat (session id or contact id). */
export function checkBookingCaps(input: {
  subAccountId: string;
  conversationKey: string;
  ip?: string | null;
}): BookingCapResult {
  const now = Date.now();
  if (recent(`conv:${input.conversationKey}`, now).length >= BOOKINGS_PER_CONVERSATION) {
    return "chat";
  }
  const k = ipKey(input.ip ?? null);
  if (k && recent(k, now).length >= BOOKINGS_PER_IP) return "visitor";
  if (recent(`sa:${input.subAccountId}`, now).length >= BOOKINGS_PER_SUB_ACCOUNT) {
    return "workspace";
  }
  return "ok";
}

export function countBooking(input: {
  subAccountId: string;
  conversationKey: string;
  ip?: string | null;
}): void {
  const now = Date.now();
  for (const key of [
    `conv:${input.conversationKey}`,
    ipKey(input.ip ?? null),
    `sa:${input.subAccountId}`,
  ]) {
    if (key) push(key, now);
  }
}

export function canChangeBooking(conversationKey: string): boolean {
  return recent(`chg:${conversationKey}`, Date.now()).length < CHANGES_PER_CONVERSATION;
}

export function countBookingChange(conversationKey: string): void {
  push(`chg:${conversationKey}`, Date.now());
}

export const MAX_BOOKINGS_PER_CONVERSATION = BOOKINGS_PER_CONVERSATION;
