import { beforeEach, expect, it, vi } from "vitest";
import { SA, post, resetBookingHarness, seedPage, slot } from "@/test/booking-harness";

/**
 * The route must hand its transaction to the contact reconcile, so the
 * unverified-phone note commits with the booking (see
 * lib/booking/contact-reconcile.test.ts for the retry / abort behaviour).
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
const reconcileInputs: Array<{ txn?: unknown }> = [];
vi.mock("@/lib/booking/contact-reconcile", () => ({
  reconcileBookingContact: async (input: { txn?: unknown }) => {
    reconcileInputs.push(input);
    return { id: "c1", created: false };
  },
}));

const { POST } = await import("./route");

beforeEach(() => {
  resetBookingHarness();
  reconcileInputs.length = 0;
});

it("reconciles the contact inside the booking transaction", async () => {
  seedPage("p");
  const res = await POST(
    post({ name: "V", email: "v@example.com", phone: "+27600000000", slot: slot("09:00", "09:30") }),
    { params: Promise.resolve({ saId: SA, slug: "p" }) },
  );
  expect(res.status).toBe(200);
  expect(reconcileInputs).toHaveLength(1);
  expect(reconcileInputs[0].txn).toBeDefined();
});
