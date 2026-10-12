import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askAgency, confirmAgency, lookupResult, mem, seedTenants } from "@/test/chat-route-harness";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";
import { PENDING_BILLING } from "@/test/preview-samples";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * N2b's agency billing tools through the real Agency Assistant chat and
 * confirm routes (an owner of ag1): billing_overview reads only ag1's
 * sub-accounts and rolls MRR up as the agency billing page does; comp_client
 * is a confirm card that comps (and cancels a live subscription) only on
 * confirm, only in ag1; resend_checkout_link is never a chat action.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { availableOn, getCapability, toolsForLevel } = await import("@/lib/ai-suite/capabilities");

restoreBillingProviderAfterEach();

const DAY = 86_400_000;
const stored = (id = "sa1") => mem.read(`subAccounts/${id}`)!.billing as Record<string, unknown>;
const billing = (over: Record<string, unknown>) => ({ ...PENDING_BILLING, checkoutTokenHash: null, ...over });

beforeEach(() => {
  seedTenants();
  spyBillingProvider("paystack");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.test");
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "test-secret-for-checkout-tokens-0123456789");
});
afterEach(async () => {
  // A comp's billing event is written after the response: never into the next test.
  await flushAfterResponse();
  vi.unstubAllEnvs();
});

/** One sub-account of each state in ag1, plus a paying one in another agency. */
function seedBook() {
  const sub = (id: string, name: string, b: Record<string, unknown> | null, agencyId = "ag1") =>
    mem.seed(`subAccounts/${id}`, { agencyId, name, ...(b ? { billing: b } : {}) });
  sub("sa1", "Active Co", billing({ status: "active", priceCents: 9900, stripeSubscriptionId: "SUB_1" }));
  sub("sa2", "Grace Co", billing({ status: "past_due", priceCents: 120000, billingInterval: "year", graceUntil: new Date(Date.now() + 3 * DAY) }));
  sub("sa3", "Lapsed Co", billing({ status: "past_due", priceCents: 5000, graceUntil: new Date(Date.now() - DAY) }));
  sub("sa4", "Pending Co", billing({}));
  sub("sa5", "Comped Co", null);
  sub("sb1", "Other Agency Co", billing({ status: "active", priceCents: 777700 }), "ag2");
}

describe("billing_overview", () => {
  it("lists ag1's clients worst first, with the billing page's MRR (active + grace, annual ÷ 12); never another agency's", async () => {
    seedBook();
    const body = await (await askAgency("billing_overview", {})).json();
    expect(body).toEqual({ type: "message", text: "done" });
    const out = lookupResult();
    expect(out.split("\n").slice(1, 6).map((l) => l.replace(/ —.*/, ""))).toEqual([
      "- Lapsed Co", "- Grace Co", "- Pending Co", "- Active Co", "- Comped Co",
    ]);
    expect(out).toContain("Client billing (1 active, 1 pending, 1 grace, 1 lapsed, 1 comped)");
    expect(out).toMatch(/GRACE, Sample plan R\s1,200\.00\/yr, grace ends/);
    // 99.00 monthly + 1,200.00 yearly / 12 = 199.00; the lapsed and pending ones count nothing.
    // (Intl puts a no-break space after the R.)
    expect(out).toMatch(/MRR \(active \+ grace, annual ÷ 12\): R\s199\.00\./);
    expect(out).not.toContain("Other Agency Co");
    expect(out).not.toContain("7,777");
  });

  it("needs-attention is pending + grace + lapsed only", async () => {
    seedBook();
    await askAgency("billing_overview", { filter: "needs-attention" });
    const out = lookupResult();
    for (const name of ["Lapsed Co", "Grace Co", "Pending Co"]) expect(out).toContain(name);
    for (const name of ["Active Co", "Comped Co"]) expect(out).not.toContain(name);
  });

  it("an unknown filter is not a lookup", () => {
    expect(getCapability("billing_overview")!.validate({ filter: "everyone" })).toMatchObject({ ok: false });
  });
});

describe("comp_client", () => {
  it("is a card; nothing changes until confirm, then ag1's client is comped and its live subscription cancelled", async () => {
    seedBook();
    const spies = spyBillingProvider("paystack");
    const body = await (await askAgency("comp_client", { subAccountId: "sa1", subAccountName: "Active Co" })).json();
    expect(body).toMatchObject({ type: "proposal", proposal: { capability: "comp_client" } });
    expect(body.proposal.summary).toBe("Comp “Active Co” — stop billing them and cancel any active subscription.");
    expect(stored().status).toBe("active");
    expect(spies.cancelSubscription).not.toHaveBeenCalled();

    const res = await confirmAgency("comp_client", body.proposal.args);
    expect(res.status).toBe(200);
    expect((await res.json()).resultText).toContain("“Active Co” is now comped");
    expect(stored()).toMatchObject({ status: "comped", planId: null, stripeSubscriptionId: null });
    expect(spies.cancelSubscription).toHaveBeenCalledWith("SUB_1");
    await flushAfterResponse();
    expect(mem.list("billingEvents")).toEqual([expect.objectContaining({ subAccountId: "sa1", event: "comped" })]);
  });

  it.each([["another agency's id", "sb1"], ["a path, not an id", "sa1/usage/2026-10"], ["a made-up id", "nope"]])(
    "%s is refused at confirm: nothing comped, no provider call",
    async (_label, id) => {
      seedBook();
      const spies = spyBillingProvider("paystack");
      const before = JSON.stringify(mem.all());
      const res = await confirmAgency("comp_client", { subAccountId: id, subAccountName: "X" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("That sub-account wasn't found in this agency.");
      expect(JSON.stringify(mem.all())).toBe(before);
      expect(spies.calls()).toBe(0);
    }
  );

  it("a padded id is not a card", () => {
    expect(getCapability("comp_client")!.validate({ subAccountId: " sa1", subAccountName: "X" })).toMatchObject({ ok: false });
  });

  it("is chat-only and for the agency owner", () => {
    const cap = getCapability("comp_client")!;
    expect(availableOn(cap, "agent")).toBe(false);
    expect(toolsForLevel("agency", { agencyRoleIsOwner: false }).map((t) => t.function.name)).not.toContain("comp_client");
  });
});

describe("resend_checkout_link is never a chat action", () => {
  it("chat is not offered it, and the confirm route refuses it: no link minted", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "W", billing: billing({ checkoutTokenHash: "old" }) });
    expect(toolsForLevel("agency", { agencyRoleIsOwner: true }).map((t) => t.function.name)).not.toContain("resend_checkout_link");
    const asked = await (await askAgency("resend_checkout_link", { subAccountId: "sa1" })).json();
    expect(asked.type).toBe("message");
    expect(asked.text).not.toContain("/pay/");
    const res = await confirmAgency("resend_checkout_link", { subAccountId: "sa1" });
    expect(res.status).toBe(400);
    expect(stored().checkoutTokenHash).toBe("old");
  });

  it("its chat refusal says so, and execute without an approval refuses whoever calls it", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "W", billing: billing({ checkoutTokenHash: "old" }) });
    const cap = getCapability("resend_checkout_link")!;
    const owner = { uid: "owner1", email: "o@example.com", displayName: "", agencyId: "ag1" };
    expect(cap.chatRefusal!({ subAccountId: "sa1" }, owner)).toContain("Manage dialog → Billing");
    await expect(cap.execute(owner, { subAccountId: "sa1" })).rejects.toThrow("can't make one from here");
    expect(stored().checkoutTokenHash).toBe("old");
  });
});
