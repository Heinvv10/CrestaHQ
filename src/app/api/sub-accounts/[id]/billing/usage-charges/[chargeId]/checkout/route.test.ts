import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, NOW, mail, mem, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * POST /api/sub-accounts/[id]/billing/usage-charges/[chargeId]/checkout: the
 * banner's and paywall's "Pay" button. Real route, real billing-service and
 * provider selection with every provider method spied, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/comms/platform-email", () => ({
  resolvePlatformSender: async () => mail.sender,
  sendPlatformEmail: (...a: unknown[]) => mail.send(...a),
  noPlatformSender: () => new Error("no sender"),
}));
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: async () => ({ name: "Agency" }) }));
const auth = vi.hoisted(() => ({ admin: true }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () =>
    auth.admin ? { uid: "u1" } : NextResponse.json({ error: "Sub-account admin only" }, { status: 403 }),
}));

const { POST } = await import("./route");
const { runUsageClose } = await import("@/lib/server/usage-billing-service");

setupUsageBillingTests();
beforeEach(() => {
  auth.admin = true;
});

const post = (chargeId = CHARGE, subAccountId = "sa1") =>
  POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: subAccountId, chargeId }) });
const patchCharge = (patch: Record<string, unknown>) =>
  mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, ...patch });

async function emailedCharge(kind: "stripe" | "paystack" = "stripe") {
  const spies = spyBillingProvider(kind);
  spies.createOneTimeCheckout.mockResolvedValue({ url: "https://pay.example.com/c1", sessionId: "cs_1" });
  await runUsageClose(NOW);
  return spies;
}

describe("the pay button's checkout route", () => {
  it("opens a checkout for the charge and returns its url, without touching the pay link", async () => {
    const spies = await emailedCharge();
    const before = mem.read(`billingCharges/${CHARGE}`)!.tokenHash;
    expect(before).toBeTruthy();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://pay.example.com/c1" });
    expect(spies.createOneTimeCheckout).toHaveBeenCalledTimes(1);
    expect(spies.createOneTimeCheckout.mock.calls[0][0]).toMatchObject({
      amountCents: 5000,
      currency: "zar",
      successUrl: "https://app.example.com/sa/sa1/dashboard",
      metadata: { chargeId: CHARGE, subAccountId: "sa1", agencyId: "ag1" },
    });
    // The link in the invoice email keeps working.
    expect(mem.read(`billingCharges/${CHARGE}`)!.tokenHash).toBe(before);
  });

  it("on Paystack the payer email is the workspace's billing recipient", async () => {
    const spies = await emailedCharge("paystack");
    expect((await post()).status).toBe(200);
    expect(spies.createOneTimeCheckout.mock.calls[0][0]).toMatchObject({ payerEmail: "client@example.com" });
  });

  it("a signed-in member who is not an admin is refused and nothing is opened", async () => {
    const spies = await emailedCharge();
    auth.admin = false;
    expect((await post()).status).toBe(403);
    expect(spies.createOneTimeCheckout).not.toHaveBeenCalled();
  });

  it("another workspace's charge is not found, even by an admin of this one", async () => {
    const spies = await emailedCharge();
    mem.seed("subAccounts/sa2", { agencyId: "ag1", name: "Two" });
    expect((await post(CHARGE, "sa2")).status).toBe(404);
    expect(spies.createOneTimeCheckout).not.toHaveBeenCalled();
  });

  it("a manual charge is not payable here", async () => {
    const spies = await emailedCharge();
    patchCharge({ kind: "manual" });
    expect((await post()).status).toBe(404);
    expect(spies.createOneTimeCheckout).not.toHaveBeenCalled();
  });

  it("a path-shaped or missing charge id is not found, even when it addresses a real nested doc", async () => {
    const spies = await emailedCharge();
    // billingCharges/{CHARGE}/x/y is a valid document path that carries this workspace's id.
    mem.seed(`billingCharges/${CHARGE}/x/y`, { ...mem.read(`billingCharges/${CHARGE}`)! });
    expect((await post(`${CHARGE}/x/y`)).status).toBe(404);
    expect((await post("usage_sa1_1999-01")).status).toBe(404);
    expect(spies.createOneTimeCheckout).not.toHaveBeenCalled();
  });

  it("a paid or waived charge answers 409 and opens nothing", async () => {
    const spies = await emailedCharge();
    for (const [status, message] of [["paid", "already paid"], ["canceled", "waived"]] as const) {
      patchCharge({ status });
      const res = await post();
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain(message);
    }
    expect(spies.createOneTimeCheckout).not.toHaveBeenCalled();
  });

  it("a provider failure is a 500 that does not leak the error", async () => {
    const spies = await emailedCharge();
    spies.createOneTimeCheckout.mockRejectedValue(new Error("sk_live_secret exploded"));
    const res = await post();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("sk_live");
  });
});
