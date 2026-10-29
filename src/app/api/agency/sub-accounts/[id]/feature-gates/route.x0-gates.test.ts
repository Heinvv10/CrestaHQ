import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/agency/sub-accounts/[id]/feature-gates — the X0 gates
 * (`agentsEnabled` / `sellOnlineEnabled` / `aiOutboundSmsEnabled` →
 * `…EnabledByAgency`). Real tenancy, real gate service, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, claims, mem, resetSync } from "@/test/gbp-sync-harness";
import { PLAN_GATE_KEYS, PLAN_GATE_LABELS } from "@/types/billing";
import { PATCH } from "./route";

async function patch(body: Record<string, unknown>, uid = "uid_owner") {
  const res = await PATCH(
    new Request(`http://127.0.0.1:3100/api/agency/sub-accounts/${SA}/feature-gates`, {
      method: "PATCH",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA }) },
  );
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

const doc = () => mem.read(`subAccounts/${SA}`);

beforeEach(() => {
  resetSync();
  claims.set("uid_owner", { status: "active", agencyId: "ag_1", agencyRole: "owner" });
});
afterEach(() => vi.restoreAllMocks());

describe.each([
  ["agentsEnabled", "agentsEnabledByAgency"],
  ["sellOnlineEnabled", "sellOnlineEnabledByAgency"],
] as const)("%s", (key, field) => {
  const others = ["agentsEnabledByAgency", "sellOnlineEnabledByAgency", "aiOutboundSmsEnabledByAgency"].filter(
    (f) => f !== field,
  );

  it("only the agency owner may change it", async () => {
    expect((await patch({ [key]: true }, "uid_admin")).status).toBe(403);
    expect(doc()?.[field]).toBeUndefined();
  });

  it("sets and clears it, writing only the field sent", async () => {
    const before = others.map((f) => doc()?.[f]);
    expect((await patch({ [key]: true })).status).toBe(200);
    expect(doc()?.[field]).toBe(true);
    expect((await patch({ [key]: false })).status).toBe(200);
    expect(doc()?.[field]).toBe(false);
    expect(others.map((f) => doc()?.[f])).toEqual(before);
  });

  it("ignores a non-boolean value", async () => {
    expect((await patch({ [key]: "true" })).status).toBe(400);
    expect(doc()?.[field]).toBeUndefined();
  });
});

describe("aiOutboundSmsEnabled", () => {
  it("refuses to enable with a 409 and writes nothing", async () => {
    const res = await patch({ aiOutboundSmsEnabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/readiness — not yet available/);
    expect(doc()?.aiOutboundSmsEnabledByAgency).toBeUndefined();
  });

  it("refuses enable even when sent alongside another gate, and applies neither", async () => {
    const res = await patch({ aiOutboundSmsEnabled: true, agentsEnabled: true });
    expect(res.status).toBe(409);
    expect(doc()?.agentsEnabledByAgency).toBeUndefined();
  });

  it("always allows disabling", async () => {
    mem.seed(`subAccounts/${SA}`, { ...doc(), aiOutboundSmsEnabledByAgency: true });
    expect((await patch({ aiOutboundSmsEnabled: false })).status).toBe(200);
    expect(doc()?.aiOutboundSmsEnabledByAgency).toBe(false);
  });

  it("only the agency owner reaches the readiness refusal", async () => {
    expect((await patch({ aiOutboundSmsEnabled: true }, "uid_admin")).status).toBe(403);
  });
});

describe("standalone gates", () => {
  it.each(["agentsEnabledByAgency", "sellOnlineEnabledByAgency", "aiOutboundSmsEnabledByAgency"])(
    "%s is not a plan gate",
    (field) => {
      expect(PLAN_GATE_KEYS).not.toContain(field);
      expect(Object.keys(PLAN_GATE_LABELS)).not.toContain(field);
    },
  );
});
