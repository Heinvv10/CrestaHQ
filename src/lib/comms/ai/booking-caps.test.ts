import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rolling-day caps on AI bookings and changes. Each limit is pinned at its
 * exact boundary (allowed at N-1, refused at N), so moving any constant by
 * one turns a test red. The buckets are module state: a fresh module per test.
 */

type Caps = typeof import("@/lib/comms/ai/booking-caps");
let caps: Caps;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T08:00:00Z"));
  vi.resetModules();
  caps = await import("@/lib/comms/ai/booking-caps");
});

afterEach(() => {
  vi.useRealTimers();
});

function bookN(n: number, at: (i: number) => { conversationKey: string; ip?: string | null; subAccountId?: string }) {
  for (let i = 0; i < n; i++) {
    const a = at(i);
    caps.countBooking({ subAccountId: a.subAccountId ?? "sa1", conversationKey: a.conversationKey, ip: a.ip });
  }
}

describe("per conversation", () => {
  it("allows 2 bookings in one conversation, refuses the 3rd", () => {
    const req = { subAccountId: "sa1", conversationKey: "chat-1", ip: "1.1.1.1" };
    bookN(1, () => req);
    expect(caps.checkBookingCaps(req)).toBe("ok");
    bookN(1, () => req);
    expect(caps.checkBookingCaps(req)).toBe("chat");
    expect(caps.MAX_BOOKINGS_PER_CONVERSATION).toBe(2);
  });

  it("another conversation from a different visitor is unaffected", () => {
    bookN(2, () => ({ conversationKey: "chat-1", ip: "1.1.1.1" }));
    expect(caps.checkBookingCaps({ subAccountId: "sa1", conversationKey: "chat-2", ip: "2.2.2.2" })).toBe("ok");
  });
});

describe("per IP", () => {
  it("allows 5 bookings from one IP across conversations, refuses the 6th", () => {
    bookN(4, (i) => ({ conversationKey: `chat-${i}`, ip: "9.9.9.9" }));
    expect(caps.checkBookingCaps({ subAccountId: "sa1", conversationKey: "chat-new", ip: "9.9.9.9" })).toBe("ok");
    bookN(1, () => ({ conversationKey: "chat-4", ip: "9.9.9.9" }));
    expect(caps.checkBookingCaps({ subAccountId: "sa1", conversationKey: "chat-new", ip: "9.9.9.9" })).toBe("visitor");
  });

  it("the IP cap spans sub-accounts", () => {
    bookN(5, (i) => ({ conversationKey: `chat-${i}`, ip: "9.9.9.9", subAccountId: `sa-${i}` }));
    expect(caps.checkBookingCaps({ subAccountId: "sa-other", conversationKey: "c", ip: "9.9.9.9" })).toBe("visitor");
  });

  it('"unknown" and a missing IP are not one shared visitor', () => {
    bookN(5, (i) => ({ conversationKey: `chat-${i}`, ip: "unknown" }));
    bookN(5, (i) => ({ conversationKey: `chat-n${i}`, ip: null }));
    expect(caps.checkBookingCaps({ subAccountId: "sa1", conversationKey: "c", ip: "unknown" })).toBe("ok");
    expect(caps.checkBookingCaps({ subAccountId: "sa1", conversationKey: "c" })).toBe("ok");
  });
});

describe("per workspace", () => {
  it("allows 50 bookings a day per sub-account, refuses the 51st", () => {
    bookN(49, (i) => ({ conversationKey: `chat-${i}`, ip: `10.0.0.${i}` }));
    expect(caps.checkBookingCaps({ subAccountId: "sa1", conversationKey: "c", ip: "10.0.1.1" })).toBe("ok");
    bookN(1, () => ({ conversationKey: "chat-49", ip: "10.0.0.49" }));
    expect(caps.checkBookingCaps({ subAccountId: "sa1", conversationKey: "c", ip: "10.0.1.1" })).toBe("workspace");
    expect(caps.checkBookingCaps({ subAccountId: "sa2", conversationKey: "c", ip: "10.0.1.1" })).toBe("ok");
  });
});

describe("changes per conversation", () => {
  it("allows 5 cancels/reschedules, refuses the 6th", () => {
    for (let i = 0; i < 4; i++) caps.countBookingChange("chat-1");
    expect(caps.canChangeBooking("chat-1")).toBe(true);
    caps.countBookingChange("chat-1");
    expect(caps.canChangeBooking("chat-1")).toBe(false);
    expect(caps.canChangeBooking("chat-2")).toBe(true);
  });

  it("changes and bookings are separate budgets", () => {
    for (let i = 0; i < 5; i++) caps.countBookingChange("chat-1");
    expect(caps.checkBookingCaps({ subAccountId: "sa1", conversationKey: "chat-1" })).toBe("ok");
  });
});

describe("rolling window", () => {
  it("a booking stops counting 24 hours later, not before", () => {
    const req = { subAccountId: "sa1", conversationKey: "chat-1", ip: "1.1.1.1" };
    bookN(2, () => req);
    vi.setSystemTime(new Date("2026-11-03T07:59:59Z"));
    expect(caps.checkBookingCaps(req)).toBe("chat");
    vi.setSystemTime(new Date("2026-11-03T08:00:00Z"));
    expect(caps.checkBookingCaps(req)).toBe("ok");
  });
});
