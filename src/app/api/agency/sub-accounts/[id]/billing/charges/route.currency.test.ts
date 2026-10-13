import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem, role, seedTenants } from "@/test/chat-route-harness";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * A one-time charge with no currency named (the Manage dialog's default) is
 * billed in the currency the client's usage overage is valued in
 * (usageCurrency), so "invoice the overage with a one-time charge" bills
 * what the dialog showed: ZAR on Paystack for a client without a plan, never
 * a hard-coded USD (PR #413 round 2). The charges list reports that default.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => ({
  ...(await import("@/test/chat-route-harness")).tenancyMock(),
  requireAgencyOwner: async () => ({ uid: "owner1", email: "o@example.com", agencyId: "ag1" }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const charges = await import("./route");
const usage = await import("../../usage/route");

restoreBillingProviderAfterEach();

const params = { params: Promise.resolve({ id: "sa1" }) };
const create = (body: Record<string, unknown>) =>
  charges.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), params);
const listed = async () => (await (await charges.GET(new Request("http://localhost/x"), params)).json()) as { currency: string };
const overageCurrency = async () =>
  ((await (await usage.GET(new Request("http://localhost/x"), params)).json()) as { currency: string }).currency;

beforeEach(() => {
  seedTenants();
  role.current = "agencyOwner";
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "test-secret-for-checkout-tokens-0123456789");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.test");
});
afterEach(async () => {
  await flushAfterResponse();
  vi.unstubAllEnvs();
});

describe("a charge's default currency is the overage currency", () => {
  it.each([
    ["paystack, no plan", "paystack", null, "zar"],
    ["stripe, no plan", "stripe", null, "usd"],
    ["paystack, a usd plan", "paystack", "usd", "usd"],
  ] as const)("%s: the overage currency", async (_label, kind, planCurrency, expected) => {
    spyBillingProvider(kind);
    if (planCurrency) mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, billing: { status: "pending", planId: "p1", currency: planCurrency } });
    expect(await overageCurrency()).toBe(expected);
    expect((await listed()).currency).toBe(expected);
    const res = await create({ description: "Overage — October", amountCents: 1000 });
    expect(res.status).toBe(201);
    expect(mem.list("billingCharges")).toEqual([expect.objectContaining({ currency: expected, amountCents: 1000 })]);
  });

  it("a currency named explicitly is kept", async () => {
    spyBillingProvider("paystack");
    await create({ description: "Setup", amountCents: 1000, currency: "usd" });
    expect(mem.list("billingCharges")).toEqual([expect.objectContaining({ currency: "usd" })]);
  });
});
