import { describe, expect, it } from "vitest";
import {
  MYSTERY_SHOP_CAP_DEFAULT,
  RESPONSE_WINDOW_MS,
  TIMER_GRACE_MS,
  canSettleMissed,
  canSettleResponded,
  inWindow,
  mysteryShopCap,
  overdue,
  toMs,
} from "./model";

const SENT = Date.parse("2026-10-08T08:00:00Z");
const shop = (status: string, extra: Record<string, unknown> = {}) => ({
  status,
  sentAt: new Date(SENT),
  respondedAt: null,
  ...extra,
});

describe("window", () => {
  it("is [sentAt, sentAt + 24 h], both ends included", () => {
    expect(RESPONSE_WINDOW_MS).toBe(24 * 3600_000);
    expect(inWindow(SENT, SENT)).toBe(true);
    expect(inWindow(SENT, SENT + RESPONSE_WINDOW_MS)).toBe(true);
    expect(inWindow(SENT, SENT + RESPONSE_WINDOW_MS + 1)).toBe(false);
    expect(inWindow(SENT, SENT - 1)).toBe(false);
  });
});

describe("transitions", () => {
  it("responded: a sent shop in the window; a missed one only when the reply was inside it (late sync)", () => {
    expect(canSettleResponded(shop("sent"), SENT + 60_000)).toBe(true);
    expect(canSettleResponded(shop("sent"), SENT + RESPONSE_WINDOW_MS + 1)).toBe(false);
    expect(canSettleResponded(shop("missed"), SENT + 3600_000)).toBe(true);
    expect(canSettleResponded(shop("missed"), SENT + RESPONSE_WINDOW_MS + 1)).toBe(false);
    for (const s of ["queued", "responded", "failed", "refused"]) {
      expect(canSettleResponded(shop(s), SENT + 60_000)).toBe(false);
    }
  });

  it("missed: only a sent shop with no response once the window is over", () => {
    expect(canSettleMissed(shop("sent"), SENT + RESPONSE_WINDOW_MS)).toBe(true);
    expect(canSettleMissed(shop("sent"), SENT + RESPONSE_WINDOW_MS - 1)).toBe(false);
    expect(canSettleMissed(shop("sent", { respondedAt: new Date(SENT + 5) }), SENT + RESPONSE_WINDOW_MS)).toBe(false);
    for (const s of ["queued", "responded", "missed", "failed", "refused"]) {
      expect(canSettleMissed(shop(s), SENT + 2 * RESPONSE_WINDOW_MS)).toBe(false);
    }
  });

  it("overdue (the GET sweep): sent and past window + grace", () => {
    expect(overdue(shop("sent"), SENT + RESPONSE_WINDOW_MS + TIMER_GRACE_MS)).toBe(true);
    expect(overdue(shop("sent"), SENT + RESPONSE_WINDOW_MS + TIMER_GRACE_MS - 1)).toBe(false);
    expect(overdue(shop("responded"), SENT + 3 * RESPONSE_WINDOW_MS)).toBe(false);
  });

  it("toMs reads a Date, a Firestore Timestamp and nothing else", () => {
    expect(toMs(new Date(SENT))).toBe(SENT);
    expect(toMs({ toMillis: () => SENT })).toBe(SENT);
    expect(toMs("2026-10-08")).toBeNull();
    expect(toMs(null)).toBeNull();
  });
});

describe("cap", () => {
  it("defaults to 10 and reads a whole number 0–1000", () => {
    expect(MYSTERY_SHOP_CAP_DEFAULT).toBe(10);
    expect(mysteryShopCap({})).toBe(10);
    expect(mysteryShopCap({ prospectingMysteryShopCap: 0 })).toBe(0);
    expect(mysteryShopCap({ prospectingMysteryShopCap: 3 })).toBe(3);
    for (const bad of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mysteryShopCap({ prospectingMysteryShopCap: bad })).toBe(10);
    }
  });
});
