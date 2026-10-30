import type { SubAccountDoc } from "@/types";

/**
 * Speed-to-lead mystery shop (Prospecting PR 5, report sections 11 and 12).
 * One neutral enquiry is sent to a prospect over one channel; the business's
 * first human response within RESPONSE_WINDOW_MS is timed, and no response is
 * a missed lead valued at the niche's job value. Pure: client-safe.
 *
 * `mysteryShops/{shopId}` is top level like `prospectReports`, written by the
 * server only. `queued` exists only while the send is in flight; `failed` and
 * `refused` never sent, and give their cap slot back.
 */

export const MYSTERY_SHOP_CHANNELS = ["email", "call", "whatsapp", "form"] as const;
export type MysteryShopChannel = (typeof MYSTERY_SHOP_CHANNELS)[number];

export type MysteryShopStatus = "queued" | "sent" | "responded" | "missed" | "failed" | "refused";

export const RESPONSE_WINDOW_MS = 24 * 3600_000;
/** IMAP sync runs every 15 min: the timer fires this long after the window, so a reply in its last minutes is in first. */
export const TIMER_GRACE_MS = 30 * 60_000;
/** An email shop waiting for the mailbox sync re-checks this often, at most MAX_TIMER_REQUEUES times. */
export const TIMER_REQUEUE_MS = 3600_000;
export const MAX_TIMER_REQUEUES = 48;
/**
 * How long after the send a late-synced reply or bounce can still change a
 * shop: the longest the missed verdict can wait for the mailbox (the timer's
 * grace plus every re-queue) past the window.
 */
export const LATE_REPLY_HORIZON_MS = RESPONSE_WINDOW_MS + TIMER_GRACE_MS + MAX_TIMER_REQUEUES * TIMER_REQUEUE_MS;
export const MYSTERY_SHOP_CAP_DEFAULT = 10;
/** R1,500 — an estimated job for a niche the sub-account has not valued. */
export const JOB_VALUE_DEFAULT_CENTS = 150_000;
export const MYSTERY_SHOP_CURRENCY = "ZAR";

export const OPEN_STATUSES: ReadonlySet<string> = new Set(["queued", "sent"]);

export interface MysteryShopFailure {
  code: string;
  reason: string;
}

/** `mysteryShops/{shopId}`. Timestamps are Dates written by the server. */
export interface MysteryShopDoc {
  agencyId: string;
  subAccountId: string;
  contactId: string;
  reportId: string | null;
  channel: MysteryShopChannel;
  /** The email, E.164 number or form URL contacted. Never public. */
  target: string;
  targetLabel: string;
  status: MysteryShopStatus;
  sentAt: Date | null;
  respondedAt: Date | null;
  responseMs: number | null;
  /** First automatic acknowledgement (out-of-office etc.); never a response. */
  autoReplyAt: Date | null;
  jobValueCents: number;
  currency: string;
  niche: string;
  enquiryText: string;
  /** Message-ID, Vapi call id, WhatsApp message id or form trace id. */
  providerRef: string | null;
  failure: MysteryShopFailure | null;
  createdByUid: string;
  confirmedAt: Date;
  createdAt: Date;
  usageMonth: string;
}

type Timed = { status?: unknown; sentAt?: unknown; respondedAt?: unknown };

/** Milliseconds of a Date or a Firestore Timestamp; null for anything else. */
export function toMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const ts = v as { toMillis?: () => number } | null;
  return typeof ts?.toMillis === "function" ? ts.toMillis() : null;
}

export function inWindow(sentAtMs: number, atMs: number): boolean {
  return atMs >= sentAtMs && atMs <= sentAtMs + RESPONSE_WINDOW_MS;
}

/** First response wins; a missed shop is upgraded only by a reply that was inside the window (late IMAP sync). */
export function canSettleResponded(shop: Timed, atMs: number): boolean {
  const sent = toMs(shop.sentAt);
  if (sent === null || (shop.status !== "sent" && shop.status !== "missed")) return false;
  return inWindow(sent, atMs);
}

export function canSettleMissed(shop: Timed, nowMs: number): boolean {
  const sent = toMs(shop.sentAt);
  return shop.status === "sent" && shop.respondedAt == null && sent !== null && nowMs >= sent + RESPONSE_WINDOW_MS;
}

/** A `sent` shop whose timer should have fired by now — the GET route settles it. */
export function overdue(shop: Timed, nowMs: number): boolean {
  const sent = toMs(shop.sentAt);
  return shop.status === "sent" && sent !== null && nowMs >= sent + RESPONSE_WINDOW_MS + TIMER_GRACE_MS;
}

/** The agency owner's monthly cap; a value written outside the PATCH route falls back to the default. */
export function mysteryShopCap(sub: Pick<SubAccountDoc, "prospectingMysteryShopCap"> | null | undefined): number {
  const cap = sub?.prospectingMysteryShopCap;
  return Number.isInteger(cap) && (cap as number) >= 0 ? (cap as number) : MYSTERY_SHOP_CAP_DEFAULT;
}
