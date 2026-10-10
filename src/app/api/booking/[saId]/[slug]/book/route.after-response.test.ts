import { beforeEach, expect, it, vi } from "vitest";
import { SA, post, resetBookingHarness, seedPage, slot } from "@/test/booking-harness";

/**
 * Serverless hosts freeze the function once the route returns, so the
 * booking_page_booked webhook must be handed to `after()` — a bare `void`
 * is cut off mid-flight. `after()` collects its tasks so the test runs them.
 */

const m = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  emitBookingWebhook: vi.fn(async () => undefined),
}));

const h = () => import("@/test/booking-harness");
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => unknown) => m.afterTasks.push(task),
}));
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => ({
  ...(await h()).bookingMocks.lifecycle(),
  emitBookingWebhook: m.emitBookingWebhook,
}));
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());

const { POST } = await import("./route");

beforeEach(() => {
  resetBookingHarness();
  m.afterTasks.length = 0;
  m.emitBookingWebhook.mockClear();
});

it("hands the booking_page_booked webhook to after() instead of starting it before the response", async () => {
  seedPage("intro");
  const res = await POST(
    post({ name: "V", email: "v@example.com", phone: "+27600000000", slot: slot("09:00", "09:30") }),
    { params: Promise.resolve({ saId: SA, slug: "intro" }) },
  );
  const body = (await res.json()) as { eventId?: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(m.emitBookingWebhook).not.toHaveBeenCalled();
  expect(m.afterTasks.length).toBeGreaterThan(0);

  await Promise.all(m.afterTasks.map((t) => t()));

  expect(m.emitBookingWebhook).toHaveBeenCalledTimes(1);
  expect(m.emitBookingWebhook).toHaveBeenCalledWith(
    expect.objectContaining({ subAccountId: SA, agencyId: "ag1", type: "booking_page_booked" }),
  );
});
