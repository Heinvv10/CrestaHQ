import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SA, mem, post, resetBookingHarness, seedPage, slot } from "@/test/booking-harness";

/**
 * Booking confirmation against the sub-account's suppression list: real book
 * route → real sendEmail → real lookup, over the booking harness's in-memory
 * Firestore. The booking itself still succeeds — the visitor chose the slot —
 * but no confirmation reaches a suppressed address.
 */

const h = () => import("@/test/booking-harness");
const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());
vi.mock("@/lib/comms/smtp", async () => (await s()).seamMocks.smtp());
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));

const { SMTP_SUB, smtpSend, suppressionSeed, wireRecipients } = await s();
const { POST } = await import("./route");

const book = () =>
  POST(post({ name: "Visitor", email: "v@example.com", phone: "+27600000000", slot: slot("09:00", "09:30") }), {
    params: Promise.resolve({ saId: SA, slug: "intro" }),
  });

beforeEach(() => {
  resetBookingHarness();
  smtpSend.mockClear();
  mem.seed(`subAccounts/${SA}`, { ...SMTP_SUB, agencyId: "ag1" });
  seedPage("intro");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("booking confirmation email", () => {
  it("is sent to an address that is not suppressed", async () => {
    expect((await book()).status).toBe(200);
    expect(wireRecipients()).toEqual(["v@example.com"]);
  });

  it("is refused for a suppressed visitor while the booking still succeeds", async () => {
    mem.seed(...suppressionSeed("v@example.com", SA));
    expect((await book()).status).toBe(200);
    expect(mem.list("events")).toHaveLength(1);
    expect(wireRecipients()).toEqual([]);
  });
});
