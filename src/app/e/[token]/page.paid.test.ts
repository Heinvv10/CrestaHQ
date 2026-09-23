import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * Stripe sends the visitor back to /e/{token}?paid=1 with the token the pay
 * button was pressed on — but confirming the payment rotated it, so the
 * success page 404'd. The pre-payment token now opens a read-only "payment
 * received" view: no reschedule, no cancel, no new link. Any other stale
 * token still 404s.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));

const { SA, mem, resetBookingHarness, seedEvent, seedPage } = await h();
const { default: PublicEventPage } = await import("./page");
const { markBookingPaidServerSide } = await import("@/lib/server/bookings-service");
const { issueEventToken } = await import("@/lib/booking/event-token");

const open = async (token: string) =>
  renderToStaticMarkup(
    (await PublicEventPage({ params: Promise.resolve({ token }) })) as ReactElement,
  );
const isNotFound = (e: unknown) => String((e as { digest?: string })?.digest).includes("404");

let token = "";
beforeEach(() => {
  resetBookingHarness();
  seedPage("p");
  const issued = issueEventToken("e1");
  token = issued.token;
  seedEvent("e1", "10:00", "10:30", {
    status: "awaiting_payment",
    title: "Intro",
    bookingPageSlug: "p",
    publicTokenHash: issued.hash,
  });
});
afterEach(() => vi.useRealTimers());

describe("the Stripe success return", () => {
  it("opens a read-only confirmation on the pre-payment token", async () => {
    expect(await markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid: null }))
      .toMatchObject({ ok: true });
    const html = await open(token);
    expect(html).toContain("Payment received");
    expect(html).not.toMatch(/reschedule|cancel/i);
  });

  it("still 404s a token that was rotated by anything but the payment", async () => {
    const next = issueEventToken("e1");
    mem.seed("events/e1", { ...mem.read("events/e1"), publicTokenHash: next.hash });
    expect(isNotFound(await open(token).catch((e: unknown) => e))).toBe(true);
  });
});
