import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { paystackKeyFingerprint, paystackKeyMode } from "@/lib/paystack/key-fingerprint";
import { LIVE_KEY, OTHER_SA, SA, mem, seedAttempt, seedLink, seedSub, stubPaystack, verified } from "@/test/paystack-links-harness";

/**
 * A mandate's authorization exists only on the Paystack account it was made
 * on. Once the connection holds another key (or none), the mandate needs
 * attention and must never be charged. Revoking is one click and final.
 *
 * Driven through the REAL connection and revoke routes over the in-memory
 * Firestore; only Paystack's HTTP API and the auth wrappers are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
const gate = vi.hoisted(() => ({ result: null as Response | null, contacts: [] as string[] }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_req: Request, subAccountId: string) =>
    ({ uid: "u9", subAccountId, subAccountRole: "admin" }),
  requireSubAccountAdmin: async (_req: Request, subAccountId: string) =>
    ({ uid: "u9", subAccountId, subAccountRole: "admin" }),
}));
vi.mock("@/lib/auth/territory-filter", () => ({
  territoryGateForContact: async (_access: unknown, contactId: string) => {
    gate.contacts.push(contactId);
    return gate.result;
  },
}));

const { POST: CONNECT, DELETE: DISCONNECT } = await import(
  "@/app/api/sub-accounts/[id]/paystack-connection/route"
);
const { POST: REVOKE } = await import(
  "@/app/api/sub-accounts/[id]/payment-mandates/[mandateId]/revoke/route"
);

const NEW_LIVE_KEY = "sk_live_k8";

function seedMandate(id: string, over: Record<string, unknown> & { secretKey?: string } = {}) {
  const { secretKey = LIVE_KEY, ...rest } = over;
  mem.seed(`paymentMandates/${id}`, {
    agencyId: "ag1",
    subAccountId: SA,
    createdByUid: "u1",
    contactId: "c1",
    recurringInvoiceId: "rec1",
    paymentLinkId: "link1",
    reference: id,
    mode: paystackKeyMode(secretKey),
    keyFingerprint: paystackKeyFingerprint(secretKey),
    status: "active",
    attention: null,
    revokedAt: null,
    revokedByUid: null,
    ...rest,
  });
  mem.seed(`paymentMandates/${id}/private/authorization`, {
    authorizationCode: `AUTH_${id}`,
    customerCode: "CUS_1",
    email: "payer@example.com",
    signature: null,
  });
}

const mandate = (id: string) => mem.read(`paymentMandates/${id}`)!;
const connect = (secretKey: string) =>
  CONNECT(
    new Request(`http://x/api/sub-accounts/${SA}/paystack-connection`, { method: "POST", body: JSON.stringify({ secretKey }) }),
    { params: Promise.resolve({ id: SA }) },
  );
const disconnect = () =>
  DISCONNECT(new Request(`http://x/api/sub-accounts/${SA}/paystack-connection`, { method: "DELETE" }), {
    params: Promise.resolve({ id: SA }),
  });
const revoke = (mandateId: string, sa = SA) =>
  REVOKE(new Request(`http://x/api/sub-accounts/${sa}/payment-mandates/${mandateId}/revoke`, { method: "POST" }), {
    params: Promise.resolve({ id: sa, mandateId }),
  });

/** Fail the next `runTransaction` call once, then behave. */
function failNextTransaction() {
  const realTx = mem.db.runTransaction;
  let failed = false;
  return vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) => {
    if (!failed) {
      failed = true;
      return Promise.reject(Object.assign(new Error("10 ABORTED: contention"), { code: 10 }));
    }
    return realTx(fn);
  });
}

beforeEach(() => {
  mem.clear();
  gate.result = null;
  gate.contacts = [];
  seedSub(SA, LIVE_KEY);
  stubPaystack((c) =>
    c.path === "/balance"
      ? { body: { status: true, data: [{ currency: "ZAR", balance: 0 }] } }
      : verified({ reference: c.path.split("/").pop()!, status: "ongoing" }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a connection change puts the mandates it strands into attention", () => {
  it("disconnect: an active mandate needs attention, with the reason", async () => {
    seedMandate("m1");
    expect((await disconnect()).status).toBe(200);
    expect(mandate("m1")).toMatchObject({ status: "attention" });
    expect(String(mandate("m1").attention)).toMatch(/disconnected/i);
  });

  it("key switch: only the mandates made under another key", async () => {
    seedMandate("old");
    seedMandate("new", { secretKey: NEW_LIVE_KEY });
    expect((await connect(NEW_LIVE_KEY)).status).toBe(200);
    expect(mandate("old")).toMatchObject({ status: "attention" });
    expect(String(mandate("old").attention)).toMatch(/key was changed/i);
    expect(mandate("new")).toMatchObject({ status: "active", attention: null });
  });

  it("reconnecting the same key leaves the mandate active", async () => {
    seedMandate("m1");
    expect((await connect(LIVE_KEY)).status).toBe(200);
    expect(mandate("m1")).toMatchObject({ status: "active", attention: null });
  });

  it("a revoked mandate stays revoked, and one already in attention keeps its first reason", async () => {
    seedMandate("gone", { status: "revoked" });
    seedMandate("att", { status: "attention", attention: "first reason" });
    await disconnect();
    expect(mandate("gone")).toMatchObject({ status: "revoked", attention: null });
    expect(mandate("att")).toMatchObject({ status: "attention", attention: "first reason" });
  });

  it("a revoke landing between the listing and the flag write is never overwritten", async () => {
    seedMandate("m1");
    const realTx = mem.db.runTransaction;
    let raced = false;
    vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) => {
      if (!raced) {
        raced = true;
        mem.seed("paymentMandates/m1", { ...mandate("m1"), status: "revoked" });
      }
      return realTx(fn);
    });
    expect((await disconnect()).status).toBe(200);
    expect(mandate("m1")).toMatchObject({ status: "revoked", attention: null });
  });

  it("never touches another sub-account's mandates", async () => {
    seedMandate("theirs", { subAccountId: OTHER_SA });
    await disconnect();
    expect(mandate("theirs")).toMatchObject({ status: "active" });
  });

  it("one failed write still flags the rest, errors the request, and a retry heals it", async () => {
    seedMandate("m1");
    seedMandate("m2");
    seedMandate("m3");
    const spy = failNextTransaction();
    await expect(disconnect()).rejects.toThrow();
    spy.mockRestore();
    const states = ["m1", "m2", "m3"].map((id) => mandate(id).status);
    expect(states.filter((s) => s === "attention")).toHaveLength(2);
    expect(states.filter((s) => s === "active")).toHaveLength(1);

    expect((await disconnect()).status).toBe(200);
    expect(["m1", "m2", "m3"].map((id) => mandate(id).status)).toEqual(["attention", "attention", "attention"]);
  });

  it("a failure flagging an ATTEMPT does not skip the mandates", async () => {
    seedLink("link1", { mode: "live" });
    seedAttempt("pl-link1-0123456789abcdef", { secretKey: LIVE_KEY });
    seedMandate("m1");
    // Keep the sweep from closing the attempt, so the flag step is reached.
    stubPaystack(() => "network-error");
    const spy = failNextTransaction();
    await expect(disconnect()).rejects.toThrow();
    spy.mockRestore();
    expect(mem.read("paymentAttempts/pl-link1-0123456789abcdef")).toMatchObject({ state: "open" });
    expect(mandate("m1")).toMatchObject({ status: "attention" });
  });
});

describe("revoke", () => {
  it("is final: revoked, who and when recorded, and the authorization deleted", async () => {
    seedMandate("m1");
    const res = await revoke("m1");
    expect(res.status).toBe(200);
    expect(mandate("m1")).toMatchObject({ status: "revoked", revokedByUid: "u9" });
    expect(mandate("m1").revokedAt).toBeTruthy();
    expect(mem.read("paymentMandates/m1/private/authorization")).toBeUndefined();
  });

  it("a mandate in attention can be revoked", async () => {
    seedMandate("m1", { status: "attention", attention: "key changed" });
    expect((await revoke("m1")).status).toBe(200);
    expect(mandate("m1")).toMatchObject({ status: "revoked" });
  });

  it("revoking twice is a no-op that keeps the first record", async () => {
    seedMandate("m1", { status: "revoked", revokedByUid: "u1", revokedAt: new Date("2026-09-01") });
    expect((await revoke("m1")).status).toBe(200);
    expect(mandate("m1")).toMatchObject({ status: "revoked", revokedByUid: "u1" });
  });

  it("another sub-account's mandate is not found, and is untouched", async () => {
    seedMandate("theirs", { subAccountId: OTHER_SA });
    expect((await revoke("theirs")).status).toBe(404);
    expect(mandate("theirs")).toMatchObject({ status: "active" });
    expect(mem.read("paymentMandates/theirs/private/authorization")).toBeDefined();
  });

  it("an unknown mandate is not found", async () => {
    expect((await revoke("nope")).status).toBe(404);
  });

  it("a territory-scoped member who cannot see the contact is refused", async () => {
    seedMandate("m1");
    gate.result = new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
    expect((await revoke("m1")).status).toBe(403);
    expect(gate.contacts).toEqual(["c1"]);
    expect(mandate("m1")).toMatchObject({ status: "active" });
  });

  it("a revoked mandate is not brought back by reconnecting its key", async () => {
    seedMandate("m1");
    await revoke("m1");
    await connect(LIVE_KEY);
    expect(mandate("m1")).toMatchObject({ status: "revoked" });
  });
});
