import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SA, mem } from "@/test/paystack-links-harness";

/**
 * Staff "Re-send delivery": the REAL route over the REAL entitlements service.
 * Only the session guard (a deny/allow switch) and outbound mail are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const access = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: access }));
const sendEmail = vi.hoisted(() =>
  vi.fn(async (_m: { to: string; subject: string }) => ({ id: "m1" })),
);
vi.mock("@/lib/comms/resend", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/resend")>()),
  sendEmail,
}));

const { POST } = await import("./route");

const DOWNLOAD = "https://files.example.com/guide.pdf";

function seedOrder(over: Record<string, unknown> = {}) {
  mem.seed("orders/ord1", {
    agencyId: "ag1",
    subAccountId: SA,
    contactId: null,
    source: "product_link",
    status: "paid",
    currency: "zar",
    totalCents: 49_900,
    livemode: false,
    buyerEmail: "buyer@example.com",
    buyerName: null,
    lineItems: [{ productId: "p1", name: "Fibre guide", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    deliveries: [{ productId: "p1", delivery: { type: "download", url: DOWNLOAD, label: "Get it" } }],
    confirmationEmail: { state: "sent", error: null, at: 1 },
    ...over,
  });
}

const call = (sa = SA, orderId = "ord1") =>
  POST(new Request("http://app.local/x", { method: "POST" }), {
    params: Promise.resolve({ id: sa, orderId }),
  });

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Acme Fibre" });
  access.mockResolvedValue({ uid: "u1", subAccountRole: "admin" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST orders/[orderId]/redeliver", () => {
  it("re-sends the delivery email (even after the confirmation carried the link) and reports the summary", async () => {
    seedOrder();
    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: 1, failed: 0, skipped: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "buyer@example.com", subject: "Your download: Fibre guide" });
    expect(mem.list("entitlements")).toEqual([expect.objectContaining({ id: "ord1_p1", subAccountId: SA, sends: 1 })]);

    await call();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(mem.list("entitlements")).toHaveLength(1);
    expect(mem.read("entitlements/ord1_p1")!.sends).toBe(2);
  });

  it("a caller who is not a sub-account admin gets the guard's answer and nothing is sent", async () => {
    seedOrder();
    access.mockResolvedValue(NextResponse.json({ error: "Sub-account admin only" }, { status: 403 }));
    const res = await call();

    expect(res.status).toBe(403);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mem.list("entitlements")).toHaveLength(0);
  });

  it("an order of another sub-account is a 404, nothing is sent", async () => {
    seedOrder({ subAccountId: "sa2" });
    const res = await call();

    expect(res.status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mem.list("entitlements")).toHaveLength(0);
  });

  it("ids that are not doc ids are a 404 before any read", async () => {
    seedOrder();
    expect((await call(SA, "ord1/../x")).status).toBe(404);
    expect((await call("a/b", "ord1")).status).toBe(404);
    expect(access).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", null, 404],
    ["pending", { status: "pending" }, 409],
    ["refunded", { status: "refunded" }, 409],
    ["held", { status: "pending", heldAt: new Date() }, 409],
    ["flagged", { attention: "Paid a different amount.", attentionOpen: true }, 409],
    ["without deliveries", { deliveries: [] }, 400],
  ] as const)("%s order: %i and nothing is sent", async (_name, over, status) => {
    if (over) seedOrder(over);
    const res = await call();

    expect(res.status).toBe(status);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mem.list("entitlements")).toHaveLength(0);
  });
});
