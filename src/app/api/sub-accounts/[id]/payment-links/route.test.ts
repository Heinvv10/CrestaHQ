import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENCY, OTHER_SA, SA, mem, seedInvoice, seedLink, seedSub } from "@/test/paystack-links-harness";

/**
 * Creating and deactivating payment links through the real routes and service
 * over an in-memory Firestore. Auth is stubbed to "member of sa1".
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_req: Request, subAccountId: string) =>
    subAccountId === "sa1"
      ? { uid: "u1", subAccountId, subAccountRole: "admin" }
      : NextResponse.json({ error: "Not a member" }, { status: 403 }),
}));
// Contact "c-hidden" is outside the caller's territory.
vi.mock("@/lib/auth/territory-filter", () => ({
  territoryGateForContact: async (_access: unknown, contactId: string | null) =>
    contactId === "c-hidden" ? NextResponse.json({ error: "Outside your territory" }, { status: 403 }) : null,
}));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";

const { POST } = await import("./route");
const { PATCH } = await import("./[linkId]/route");

function create(body: unknown, sa = SA) {
  return POST(
    new Request(`http://x/api/sub-accounts/${sa}/payment-links`, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: sa }) },
  );
}

const onlyLink = () => {
  const all = mem.list("paymentLinks");
  expect(all).toHaveLength(1);
  return all[0];
};

beforeEach(() => {
  mem.clear();
  seedSub();
});

describe("POST — create", () => {
  it("stores an ad-hoc link with tenancy keys, status open, and a token", async () => {
    const res = await create({ amountCents: 45000, description: " Call-out fee " });
    expect(res.status).toBe(200);
    const link = onlyLink();
    expect(link).toMatchObject({
      agencyId: AGENCY,
      subAccountId: SA,
      createdByUid: "u1",
      invoiceId: null,
      amountCents: 45000,
      currency: "ZAR",
      description: "Call-out fee",
      status: "open",
      active: true,
    });
    expect((await res.json()).token).toBe(link.token);
  });

  it("takes an invoice link's amount from the invoice total, not the body", async () => {
    seedInvoice();
    expect((await create({ invoiceId: "inv1", amountCents: 1 })).status).toBe(200);
    expect(onlyLink()).toMatchObject({ invoiceId: "inv1", amountCents: 115000, description: "Invoice INV-2026-0001" });
  });

  it("stores no per-link mode — the connection's current mode decides", async () => {
    await create({ amountCents: 45000, description: "x" });
    expect(onlyLink()).not.toHaveProperty("livemode");
  });

  it("returns the existing active link for an invoice instead of making a second", async () => {
    seedInvoice();
    const a = await (await create({ invoiceId: "inv1" })).json();
    const b = await (await create({ invoiceId: "inv1" })).json();
    expect(b).toEqual(a);
    expect(mem.list("paymentLinks")).toHaveLength(1);
  });

  it("makes a new invoice link once the old one is deactivated", async () => {
    seedInvoice();
    const a = await (await create({ invoiceId: "inv1" })).json();
    mem.seed(`paymentLinks/${a.id}`, { ...mem.read(`paymentLinks/${a.id}`), active: false });
    const b = await (await create({ invoiceId: "inv1" })).json();
    expect(b.id).not.toBe(a.id);
    expect(mem.list("paymentLinks")).toHaveLength(2);
  });

  it.each([
    ["a fractional amount", { amountCents: 10.5, description: "x" }],
    ["a zero amount", { amountCents: 0, description: "x" }],
    ["a string amount", { amountCents: "450", description: "x" }],
    ["no description", { amountCents: 450 }],
  ])("refuses %s", async (_label, body) => {
    expect((await create(body)).status).toBe(400);
    expect(mem.list("paymentLinks")).toEqual([]);
  });

  it("refuses an invoice from another sub-account", async () => {
    seedInvoice("inv1", { subAccountId: OTHER_SA });
    expect((await create({ invoiceId: "inv1" })).status).toBe(404);
    expect(mem.list("paymentLinks")).toEqual([]);
  });

  it("refuses a non-ZAR invoice", async () => {
    seedInvoice("inv1", { currency: "USD" });
    expect((await create({ invoiceId: "inv1" })).status).toBe(409);
  });

  it("refuses an expired invoice", async () => {
    seedInvoice("inv1", { validUntil: { seconds: Math.floor(Date.now() / 1000) - 86_400 } });
    expect((await create({ invoiceId: "inv1" })).status).toBe(409);
    expect(mem.list("paymentLinks")).toEqual([]);
  });

  it("refuses an invoice for a contact outside the caller's territory", async () => {
    seedInvoice("inv1", { contactId: "c-hidden" });
    expect((await create({ invoiceId: "inv1" })).status).toBe(403);
    expect(mem.list("paymentLinks")).toEqual([]);
  });

  it("refuses a draft invoice", async () => {
    seedInvoice("inv1", { status: "draft" });
    expect((await create({ invoiceId: "inv1" })).status).toBe(409);
  });

  it("refuses when Paystack is not connected", async () => {
    mem.seed(`subAccounts/${SA}/private/paystackConnection`, {});
    expect((await create({ amountCents: 45000, description: "x" })).status).toBe(409);
  });

  it("refuses when the agency has Payments off", async () => {
    mem.seed(`subAccounts/${SA}`, { agencyId: AGENCY, paymentsEnabledByAgency: false });
    expect((await create({ amountCents: 45000, description: "x" })).status).toBe(403);
  });

  it("refuses a non-member", async () => {
    expect((await create({ amountCents: 45000, description: "x" }, OTHER_SA)).status).toBe(403);
  });
});

describe("PATCH — deactivate", () => {
  const patch = (linkId: string, body: unknown = { active: false }) =>
    PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: SA, linkId }),
    });

  it("deactivates the tenant's own link", async () => {
    seedLink();
    expect((await patch("link1")).status).toBe(200);
    expect(mem.read("paymentLinks/link1")).toMatchObject({ active: false, status: "open" });
  });

  it("will not touch another sub-account's link", async () => {
    seedLink("link1", { subAccountId: OTHER_SA });
    expect((await patch("link1")).status).toBe(404);
    expect(mem.read("paymentLinks/link1")).toMatchObject({ active: true });
  });

  it("will not deactivate a link for a contact outside the caller's territory", async () => {
    seedLink("link1", { contactId: "c-hidden", invoiceId: "inv1" });
    expect((await patch("link1")).status).toBe(403);
    expect(mem.read("paymentLinks/link1")).toMatchObject({ active: true });
  });

  it("refuses anything but { active: false }", async () => {
    seedLink();
    expect((await patch("link1", { active: true, status: "paid" })).status).toBe(400);
    expect(mem.read("paymentLinks/link1")).toMatchObject({ active: true, status: "open" });
  });
});
