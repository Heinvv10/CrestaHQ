import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * A visitor link never reaches an event imported from a member's Google
 * Calendar. The seed gives the imported event everything a booking has — a
 * page, a live token hash, a status the route acts on — so only `source`
 * decides: the /e page, cancel, reschedule and pay all answer not found and
 * change nothing.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());
vi.mock("@/lib/google-calendar/push", () => ({
  pushBookingToGoogle: async () => undefined,
  pushBookingToGoogleAfterResponse: () => undefined,
}));
const createSession = vi.fn(async () => ({ id: "cs_1", url: "https://checkout.stripe.test/cs_1", livemode: false }));
vi.mock("@/lib/stripe/sub-account-client", () => ({
  createCheckoutSessionForSubAccount: () => createSession(),
  getSubAccountStripe: async () => ({}),
  StripeConnectionError: class extends Error {},
}));
vi.mock("@/lib/server/orders-service", () => ({ createPendingOrder: async () => undefined }));

const { mem, post, resetBookingHarness, seedEvent, seedPage, slot } = await h();
const { default: PublicEventPage } = await import("@/app/e/[token]/page");
const { POST: cancel } = await import("./cancel/route");
const { POST: reschedule } = await import("./reschedule/route");
const { POST: pay } = await import("./pay/route");
const { issueEventToken } = await import("@/lib/booking/event-token");

const isNotFound = (e: unknown) => String((e as { digest?: string })?.digest).includes("404");
const params = (token: string) => ({ params: Promise.resolve({ token }) });

let token = "";
function seed(over: Record<string, unknown>) {
  const issued = issueEventToken("e1");
  token = issued.token;
  seedEvent("e1", "10:00", "10:30", {
    title: "Dentist",
    bookingPageSlug: "p",
    contactId: "c1",
    publicTokenHash: issued.hash,
    ...over,
  });
}

beforeEach(() => {
  resetBookingHarness();
  createSession.mockClear();
  seedPage("p");
});
afterEach(() => vi.useRealTimers());

describe("an imported Google event behind a visitor link", () => {
  beforeEach(() => seed({ source: "google" }));

  it("the /e page is not found", async () => {
    const err = await PublicEventPage(params(token)).catch((e: unknown) => e);
    expect(isNotFound(err)).toBe(true);
  });

  it("can't be cancelled", async () => {
    expect((await cancel(new Request("http://x/api", { method: "POST" }), params(token))).status).toBe(404);
    expect(mem.read("events/e1")?.status).toBe("scheduled");
  });

  it("can't be rescheduled", async () => {
    expect((await reschedule(post({ slot: slot("11:00", "11:30") }), params(token))).status).toBe(404);
    expect((mem.read("events/e1")?.startAt as { toDate: () => Date }).toDate().toISOString()).toBe(
      "2026-09-14T10:00:00.000Z",
    );
  });

  it("can't be paid", async () => {
    seed({ source: "google", status: "awaiting_payment", paymentRequired: true, paymentAmount: 100, paymentCurrency: "ZAR" });
    const res = await pay(new Request("http://x/api", { method: "POST", headers: { "x-forwarded-for": "10.9.9.9" } }), params(token));
    expect(res.status).toBe(404);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("the same event as a booking (control)", () => {
  beforeEach(() => seed({ source: "booking_page" }));

  it("opens and cancels", async () => {
    expect(renderToStaticMarkup((await PublicEventPage(params(token))) as ReactElement)).toContain("Cancel booking");
    expect((await cancel(new Request("http://x/api", { method: "POST" }), params(token))).status).toBe(200);
    expect(mem.read("events/e1")?.status).toBe("cancelled");
  });
});
