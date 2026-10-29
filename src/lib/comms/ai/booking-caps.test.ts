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

const web = (ip: string | null) => ({ ip });

function reserveN(
  n: number,
  at: (i: number) => { conversationKey: string; visitor?: { ip: string | null } | null; subAccountId?: string },
) {
  for (let i = 0; i < n; i++) {
    const a = at(i);
    const r = caps.reserveBooking({
      subAccountId: a.subAccountId ?? "sa1",
      conversationKey: a.conversationKey,
      visitor: a.visitor === undefined ? web("1.1.1.1") : a.visitor,
    });
    expect(r.ok).toBe(true);
  }
}

describe("per conversation", () => {
  it("allows 2 bookings in one conversation, refuses the 3rd without counting it", () => {
    const req = { subAccountId: "sa1", conversationKey: "chat-1", visitor: web("1.1.1.1") };
    expect(caps.reserveBooking(req).ok).toBe(true);
    expect(caps.peekBookingCaps(req)).toBe("ok");
    expect(caps.reserveBooking(req).ok).toBe(true);
    expect(caps.reserveBooking(req)).toEqual({ ok: false, scope: "chat" });
    expect(caps.peekBookingCaps(req)).toBe("chat");
    expect(caps.MAX_BOOKINGS_PER_CONVERSATION).toBe(2);
    // The refused attempt didn't count against the IP (1.1.1.1 has 2 of 5).
    reserveN(3, (i) => ({ conversationKey: `other-${i}` }));
  });

  it("over-long conversation keys are cut, which only merges buckets", () => {
    const long = "k".repeat(128);
    reserveN(2, (i) => ({ conversationKey: `${long}${i}`, visitor: null }));
    expect(caps.reserveBooking({ subAccountId: "sa1", conversationKey: `${long}z`, visitor: null }).ok).toBe(false);
  });

  it("the same conversation key in another sub-account is a different conversation", () => {
    reserveN(2, () => ({ conversationKey: "contact-1", visitor: null }));
    expect(caps.reserveBooking({ subAccountId: "sa2", conversationKey: "contact-1", visitor: null }).ok).toBe(true);
  });
});

describe("per IP", () => {
  it("allows 5 bookings from one IP across conversations, refuses the 6th", () => {
    reserveN(5, (i) => ({ conversationKey: `chat-${i}`, visitor: web("9.9.9.9") }));
    expect(caps.reserveBooking({ subAccountId: "sa1", conversationKey: "new", visitor: web("9.9.9.9") })).toEqual({
      ok: false,
      scope: "visitor",
    });
  });

  it("spellings of one address are one visitor", () => {
    const spellings = [" 9.9.9.9", "::ffff:9.9.9.9", "9.9.9.9 ", "::FFFF:9.9.9.9", "9.9.9.9"];
    reserveN(5, (i) => ({ conversationKey: `chat-${i}`, visitor: web(spellings[i]) }));
    expect(caps.reserveBooking({ subAccountId: "sa1", conversationKey: "new", visitor: web("9.9.9.9") }).ok).toBe(false);
  });

  it("one IPv6 /64 is one visitor; another /64 is not", () => {
    reserveN(5, (i) => ({ conversationKey: `chat-${i}`, visitor: web(`2001:DB8:1:2::${i + 1}`) }));
    expect(caps.reserveBooking({ subAccountId: "sa1", conversationKey: "n", visitor: web("2001:db8:1:2:ffff::9") }).ok).toBe(false);
    expect(caps.reserveBooking({ subAccountId: "sa1", conversationKey: "n2", visitor: web("2001:db8:1:3::1") }).ok).toBe(true);
    expect(caps.ipBucket("2001:db8:1:2::1%eth0")).toBe("ip6:2001:db8:1:2::/64");
  });

  it("the IP cap spans sub-accounts", () => {
    reserveN(5, (i) => ({ conversationKey: `chat-${i}`, visitor: web("9.9.9.9"), subAccountId: `sa-${i}` }));
    expect(caps.reserveBooking({ subAccountId: "sa-other", conversationKey: "c", visitor: web("9.9.9.9") }).ok).toBe(false);
  });
});

describe("web visitors without a usable IP", () => {
  it('share one bucket per workspace: 10 allowed, the 11th refused, whatever the "IP"', () => {
    const bad = [null, "", "unknown", " UNKNOWN ", "not-an-ip", `1.2.3.4${"0".repeat(80)}`];
    reserveN(10, (i) => ({ conversationKey: `chat-${i}`, visitor: web(bad[i % bad.length]) }));
    expect(caps.reserveBooking({ subAccountId: "sa1", conversationKey: "new", visitor: web(null) })).toEqual({
      ok: false,
      scope: "visitor",
    });
    expect(caps.reserveBooking({ subAccountId: "sa2", conversationKey: "new", visitor: web(null) }).ok).toBe(true);
  });

  it("a channel without IPs (messaging, phone) has no IP bucket", () => {
    reserveN(12, (i) => ({ conversationKey: `contact-${i}`, visitor: null }));
  });
});

describe("per workspace", () => {
  it("allows 50 bookings a day per sub-account, refuses the 51st", () => {
    reserveN(50, (i) => ({ conversationKey: `chat-${i}`, visitor: web(`10.0.0.${i}`) }));
    expect(caps.reserveBooking({ subAccountId: "sa1", conversationKey: "c", visitor: web("10.0.1.1") })).toEqual({
      ok: false,
      scope: "workspace",
    });
    expect(caps.reserveBooking({ subAccountId: "sa2", conversationKey: "c", visitor: web("10.0.1.1") }).ok).toBe(true);
  });
});

describe("release", () => {
  it("gives the reservation back on every bucket, once", () => {
    const req = { subAccountId: "sa1", conversationKey: "chat-1", visitor: web("1.1.1.1") };
    const first = caps.reserveBooking(req);
    if (!first.ok) throw new Error("unexpected");
    expect(caps.reserveBooking(req).ok).toBe(true);
    first.release();
    first.release();
    expect(caps.reserveBooking(req).ok).toBe(true);
    expect(caps.reserveBooking(req).ok).toBe(false);
  });

  it("releasing the conversation's slot also gives back the IP's", () => {
    for (let i = 0; i < 5; i++) {
      const r = caps.reserveBooking({ subAccountId: "sa1", conversationKey: `c-${i}`, visitor: web("8.8.8.8") });
      if (r.ok && i === 4) r.release();
    }
    expect(caps.reserveBooking({ subAccountId: "sa1", conversationKey: "c-new", visitor: web("8.8.8.8") }).ok).toBe(true);
  });
});

describe("changes per conversation", () => {
  it("allows 5 cancels/reschedules, refuses the 6th", () => {
    for (let i = 0; i < 5; i++) expect(caps.reserveChange("sa1", "chat-1").ok).toBe(true);
    expect(caps.reserveChange("sa1", "chat-1")).toEqual({ ok: false, scope: "chat" });
    expect(caps.reserveChange("sa1", "chat-2").ok).toBe(true);
    expect(caps.reserveChange("sa2", "chat-1").ok).toBe(true);
  });

  it("a released change is given back", () => {
    for (let i = 0; i < 4; i++) caps.reserveChange("sa1", "chat-1");
    const fifth = caps.reserveChange("sa1", "chat-1");
    if (!fifth.ok) throw new Error("unexpected");
    fifth.release();
    expect(caps.reserveChange("sa1", "chat-1").ok).toBe(true);
  });

  it("changes and bookings are separate budgets", () => {
    for (let i = 0; i < 5; i++) caps.reserveChange("sa1", "chat-1");
    expect(caps.reserveBooking({ subAccountId: "sa1", conversationKey: "chat-1", visitor: null }).ok).toBe(true);
  });
});

describe("rolling window and prune", () => {
  it("a booking stops counting 24 hours later, not before", () => {
    const req = { subAccountId: "sa1", conversationKey: "chat-1", visitor: web("1.1.1.1") };
    reserveN(2, () => req);
    vi.setSystemTime(new Date("2026-11-03T07:59:59Z"));
    expect(caps.peekBookingCaps(req)).toBe("chat");
    vi.setSystemTime(new Date("2026-11-03T08:00:00Z"));
    expect(caps.peekBookingCaps(req)).toBe("ok");
  });

  it("past 5000 keys, expired buckets are dropped and live ones kept", () => {
    for (let i = 0; i < 2600; i++) caps.reserveChange("sa1", `old-${i}`);
    vi.setSystemTime(new Date("2026-11-02T20:00:00Z"));
    for (let i = 0; i < 2400; i++) caps.reserveChange("sa1", `live-${i}`);
    expect(caps.capBucketCount()).toBe(5000);
    vi.setSystemTime(new Date("2026-11-03T08:00:01Z"));
    caps.reserveChange("sa1", "trigger");
    expect(caps.capBucketCount()).toBe(2401);
  });
});
