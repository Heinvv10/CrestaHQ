import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import { deliverTo, mem, seedConnection, seedInvoice, seedOrder, session } from "@/test/stripe-orders-harness";

/**
 * Seam test: a flagged order (money that settled nothing) emails the
 * sub-account's admins once — Stripe redelivering the same event must not send a second
 * email. Signed event → real route → real reconciler → real orders service →
 * real notice claim; only the email transport and outbound effects are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/stripe-orders-harness")).adminMock());
vi.mock("@/lib/quotes/lifecycle", () => ({
  recordQuoteActivity: vi.fn(async () => {}),
  fireQuoteTrigger: vi.fn(async () => {}),
  emitQuoteWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn(async () => {}) }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: vi.fn(async () => {}) }));
const sendEmail = vi.hoisted(() => vi.fn(async (_m: { to: string; text: string }) => ({ id: "m1" })));
vi.mock("@/lib/comms/resend", () => ({ emailIsConfigured: () => true, sendEmail }));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-32-characters-long";
const deliver = deliverTo((await import("./route")).POST);

beforeEach(() => {
  mem.clear();
  sendEmail.mockClear();
  seedConnection();
  mem.seed("agencies/ag1", { ownerUid: "owner1" });
  mem.seed("users/owner1", { email: "owner@example.com" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Gym" });
  mem.seed("subAccounts/sa1/subAccountMembers/a1", { role: "admin", status: "active", email: "admin@gym.example" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("a second payment for a paid invoice emails the sub-account admins once, across redeliveries", async () => {
  seedInvoice();
  seedOrder("o1");
  seedOrder("o2");
  expect((await deliver("checkout.session.completed", session("cs_o1"))).status).toBe(200);
  await flushAfterResponse();
  expect(sendEmail).not.toHaveBeenCalled();

  expect((await deliver("checkout.session.completed", session("cs_o2"), "evt_2")).status).toBe(200);
  expect((await deliver("checkout.session.completed", session("cs_o2"), "evt_2")).status).toBe(200);

  expect(mem.read("orders/o2")).toMatchObject({ attention: expect.stringMatching(/already paid/i), attentionOpen: true });
  await flushAfterResponse();
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "admin@gym.example" });
  expect(sendEmail.mock.calls[0][0].text).toContain("pi_cs_o2");
});
