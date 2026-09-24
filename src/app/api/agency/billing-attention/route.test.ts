import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Attention routes over the real tenancy guards and service, on an in-memory
 * Firestore. Callers are identified the way middleware does it (x-user-uid)
 * and their custom claims come from a stubbed Auth.
 */

const mem = vi.hoisted(() => ({ ref: null as ReturnType<typeof createMemoryFirestore> | null }));
const claims: Record<string, Record<string, unknown>> = {
  owner1: { status: "active", agencyId: "ag1", agencyRole: "owner" },
  owner2: { status: "active", agencyId: "ag2", agencyRole: "owner" },
  admin1: { status: "active", agencyId: "ag1", agencyRole: null },
  collab1: { status: "active", agencyId: "ag1", agencyRole: null },
};
vi.mock("@/lib/firebase/admin", async () => {
  const { createMemoryFirestore: make } = await import("@/test/memory-firestore");
  mem.ref = make();
  return {
    getAdminDb: () => mem.ref!.db,
    getAdminAuth: () => ({ getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }) }),
  };
});
vi.mock("@/lib/comms/resend", () => ({ emailIsConfigured: () => false, sendEmail: vi.fn() }));

const agency = await import("./route");
const orders = await import("@/app/api/sub-accounts/[id]/order-attention/route");
const { orderFlagId } = await import("@/lib/server/billing-attention");
const db = () => mem.ref!;

const req = (uid: string, body?: unknown) =>
  new Request("http://x/api", {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-user-uid": uid, "x-user-email": `${uid}@example.com`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function flag(id: string, agencyId: string, over: Record<string, unknown> = {}) {
  db().seed(`billingEvents/${id}`, {
    agencyId,
    subAccountId: "sa1",
    event: "payment.flagged",
    detail: { provider: "paystack", reference: `ref_${id}`, kind: "plan", reason: "Workspace is comped", amountCents: 99900, currency: "zar" },
    createdAt: new Date("2026-09-20T10:00:00Z"),
    ...over,
  });
}

beforeEach(() => {
  db().clear();
  db().seed("subAccounts/sa1", { agencyId: "ag1", name: "Gym" });
  db().seed("subAccounts/sa2", { agencyId: "ag1", name: "Cafe" });
  db().seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
  db().seed("subAccounts/sa1/subAccountMembers/collab1", { status: "active", role: "collaborator" });
});

describe("agency billing attention", () => {
  it("lists only this agency's unresolved flagged events", async () => {
    flag("f1", "ag1");
    flag("f2", "ag2");
    flag("a1", "ag1", { event: "activated" });
    flag("s1", "ag1", {
      event: "subscription.flagged",
      subAccountId: null,
      detail: { subscriptionId: "SUB_X", customerId: "CUS_1", planCode: null, candidates: ["sa1", "sa2"] },
    });

    const res = await agency.GET(req("owner1"));
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(items.map((i) => i.flagId).sort()).toEqual(["event-f1", "event-s1"]);
    expect(items.find((i) => i.flagId === "event-f1")).toMatchObject({
      subAccountId: "sa1",
      reason: "Workspace is comped",
      amountCents: 99900,
      currency: "zar",
      reference: "ref_f1",
    });
    expect(items.find((i) => i.flagId === "event-s1")).toMatchObject({ candidates: ["sa1", "sa2"], reference: "SUB_X" });
  });

  it("is owner-only", async () => {
    expect((await agency.GET(req("admin1"))).status).toBe(403);
    expect((await agency.POST(req("admin1", { flagId: "event-f1" }))).status).toBe(403);
  });

  it("resolves a flag, recording who, and it stays resolved when the flag is re-written", async () => {
    flag("f1", "ag1");
    expect((await agency.POST(req("owner1", { flagId: "event-f1" }))).status).toBe(200);
    expect(db().read("billingAttention/event-f1")).toMatchObject({
      agencyId: "ag1",
      resolvedByUid: "owner1",
      resolvedByEmail: "owner1@example.com",
      resolvedAt: expect.anything(),
    });
    // A provider redelivery re-writes the flag row itself.
    flag("f1", "ag1");
    const { items } = (await (await agency.GET(req("owner1"))).json()) as { items: unknown[] };
    expect(items).toEqual([]);
  });

  it("will not resolve another agency's flag", async () => {
    flag("f1", "ag1");
    expect((await agency.POST(req("owner2", { flagId: "event-f1" }))).status).toBe(404);
    expect(db().read("billingAttention/event-f1")).toBeUndefined();
  });
});

describe("order attention", () => {
  function order(id: string, sa: string, attention: string | null) {
    db().seed(`orders/${id}`, {
      agencyId: "ag1",
      subAccountId: sa,
      attention,
      totalCents: 115000,
      currency: "zar",
      stripePaymentIntentId: `pi_${id}`,
      stripeCheckoutSessionId: `cs_${id}`,
      createdAt: new Date("2026-09-20T10:00:00Z"),
    });
  }

  it("lists this sub-account's flagged orders to its admin and the agency owner", async () => {
    order("o1", "sa1", "Paid, but the invoice was already paid");
    order("o2", "sa1", null);
    order("o3", "sa2", "Other workspace's flag");

    for (const uid of ["admin1", "owner1"]) {
      const res = await orders.GET(req(uid), ctx("sa1"));
      expect(res.status).toBe(200);
      const { items } = (await res.json()) as { items: Array<Record<string, unknown>> };
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ orderId: "o1", reference: "pi_o1", amountCents: 115000 });
    }
  });

  it("refuses collaborators and other agencies' owners", async () => {
    order("o1", "sa1", "flag");
    expect((await orders.GET(req("collab1"), ctx("sa1"))).status).toBe(403);
    expect((await orders.GET(req("owner2"), ctx("sa1"))).status).toBe(403);
    // An admin of sa1 has no membership in sa2.
    expect((await orders.GET(req("admin1"), ctx("sa2"))).status).toBe(403);
    const body = { orderId: "o1", flagId: orderFlagId("o1", "flag") };
    expect((await orders.POST(req("collab1", body), ctx("sa1"))).status).toBe(403);
    expect(db().read(`billingAttention/${body.flagId}`)).toBeUndefined();
  });

  it("will not resolve an order through another sub-account", async () => {
    order("o3", "sa2", "flag");
    db().seed("subAccounts/sa2/subAccountMembers/admin1", { status: "active", role: "admin" });
    const body = { orderId: "o3", flagId: orderFlagId("o3", "flag") };
    expect((await orders.POST(req("admin1", body), ctx("sa1"))).status).toBe(404);
    expect(db().read(`billingAttention/${body.flagId}`)).toBeUndefined();
  });

  it("resolves the note the admin saw; a changed note is a new flag", async () => {
    order("o1", "sa1", "first problem");
    const seen = orderFlagId("o1", "first problem");
    order("o1", "sa1", "second problem");
    expect((await orders.POST(req("admin1", { orderId: "o1", flagId: seen }), ctx("sa1"))).status).toBe(409);

    const current = orderFlagId("o1", "second problem");
    expect((await orders.POST(req("admin1", { orderId: "o1", flagId: current }), ctx("sa1"))).status).toBe(200);
    expect(db().read(`billingAttention/${current}`)).toMatchObject({ resolvedByUid: "admin1", subAccountId: "sa1" });
    const { items } = (await (await orders.GET(req("admin1"), ctx("sa1"))).json()) as { items: unknown[] };
    expect(items).toEqual([]);
  });
});
