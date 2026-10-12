import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem, role, seedTenants } from "@/test/chat-route-harness";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";
import { PENDING_BILLING } from "@/test/preview-samples";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * The Manage dialog's comp (PATCH action "comp") through the real route and
 * billing service: a live subscription the provider won't cancel leaves the
 * client exactly as it was and answers non-2xx with the provider named —
 * never "comped" while the provider keeps charging (PR #413 round 1).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { PATCH } = await import("./route");

restoreBillingProviderAfterEach();

/** The store, with a released comp lock (two nulls: no mark) read as no lock. */
const settled = () => JSON.stringify(mem.all()).replace(/,"retiringSubscriptionId":null,"retiringSince":null/g, "");

const comp = () =>
  PATCH(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ action: "comp" }) }), {
    params: Promise.resolve({ id: "sa1" }),
  });

beforeEach(() => {
  seedTenants();
  role.current = "agencyOwner";
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Paying Co", billing: { ...PENDING_BILLING, status: "active", stripeSubscriptionId: "SUB_1" } });
});
afterEach(() => flushAfterResponse());

describe("PATCH comp", () => {
  it.each(["paystack", "stripe"] as const)("%s refuses to cancel: 502 naming it, nothing changed, no billing event", async (kind) => {
    const spies = spyBillingProvider(kind);
    spies.cancelSubscription.mockRejectedValueOnce(new Error("provider down"));
    const before = settled();
    const res = await comp();
    expect(res.status).toBe(502);
    const name = kind === "paystack" ? "Paystack" : "Stripe";
    expect((await res.json()).error).toBe(`Couldn't cancel the subscription with ${name} — nothing changed; try again or cancel it in the ${name} dashboard.`);
    await flushAfterResponse();
    expect(settled()).toBe(before);
  });

  it("no payment provider configured with a live subscription on record: refused, nothing changed", async () => {
    spyBillingProvider("none");
    const before = settled();
    expect((await comp()).status).toBe(502);
    expect(settled()).toBe(before);
  });

  it("a plan switch holding its mark: 409, nothing cancelled, nothing changed", async () => {
    const spies = spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { ...(mem.read("subAccounts/sa1")!.billing as object), retiringSubscriptionId: "SUB_1", retiringSince: new Date() } });
    const before = JSON.stringify(mem.all());
    const res = await comp();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("A plan change is in progress");
    expect(spies.cancelSubscription).not.toHaveBeenCalled();
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it("the provider cancels: comped, the subscription cleared, the event recorded", async () => {
    const spies = spyBillingProvider("paystack");
    const res = await comp();
    expect(res.status).toBe(200);
    expect(spies.cancelSubscription).toHaveBeenCalledWith("SUB_1", null);
    expect(mem.read("subAccounts/sa1")!.billing).toMatchObject({ status: "comped", stripeSubscriptionId: null });
    await flushAfterResponse();
    expect(mem.list("billingEvents")).toEqual([
      expect.objectContaining({ event: "comped", detail: { previousStatus: "active", canceledSubscription: "SUB_1" } }),
    ]);
  });
});
