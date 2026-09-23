import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A manual event longer than a slot is stamped `isLong`, which is what the
 * availability read's long-event query finds it by.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { SA, mem } = await h();
const { createEventServerSide } = await import("./events-service");

const H = 3600_000;
const create = (hours: number) =>
  createEventServerSide({
    subAccountId: SA,
    agencyId: "ag1",
    createdByUid: "u1",
    mode: "live",
    title: "Out of office",
    startAt: new Date("2026-09-14T00:00:00Z"),
    endAt: new Date(Date.parse("2026-09-14T00:00:00Z") + hours * H),
    contactId: null,
    location: "",
    notes: "",
  });

beforeEach(() => mem.clear());

describe("manual event create", () => {
  it("flags an event over 8 h long, and not one of 8 h", async () => {
    const long = await create(72);
    const short = await create(8);
    expect(mem.read(`events/${long.id}`)?.isLong).toBe(true);
    expect(mem.read(`events/${short.id}`)?.isLong).toBe(false);
  });
});
