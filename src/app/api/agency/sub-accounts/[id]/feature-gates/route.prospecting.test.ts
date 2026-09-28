import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/agency/sub-accounts/[id]/feature-gates — the Prospecting gate
 * (`prospectingEnabled` → `prospectingEnabledByAgency`), its sidebar
 * hide-override and the monthly report quota. Real tenancy, real gate
 * service, in-memory Firestore.
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
  return res.status;
}

const sub = () => mem.read(`subAccounts/${SA}`) ?? {};

beforeEach(() => {
  resetSync();
  claims.set("uid_owner", { status: "active", agencyId: "ag_1", agencyRole: "owner" });
});
afterEach(() => vi.restoreAllMocks());

describe("prospectingEnabled", () => {
  it("only the agency owner may change it", async () => {
    expect(await patch({ prospectingEnabled: true }, "uid_admin")).toBe(403);
    expect(sub().prospectingEnabledByAgency).toBeUndefined();
  });

  it("writes the gate both ways", async () => {
    expect(await patch({ prospectingEnabled: true })).toBe(200);
    expect(sub().prospectingEnabledByAgency).toBe(true);
    expect(await patch({ prospectingEnabled: false })).toBe(200);
    expect(sub().prospectingEnabledByAgency).toBe(false);
  });

  it("writes the sidebar hide-override on its own", async () => {
    expect(await patch({ prospectingHiddenWhenDisabled: false })).toBe(200);
    expect(sub().prospectingHiddenWhenDisabled).toBe(false);
    expect(sub().prospectingEnabledByAgency).toBeUndefined();
  });

  it("is a plan gate, labelled", () => {
    expect(PLAN_GATE_KEYS).toContain("prospectingEnabledByAgency");
    expect(PLAN_GATE_LABELS.prospectingEnabledByAgency).toBe("Prospecting");
  });

  it("the Workspace Assistant can flip it by name", async () => {
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const cap = getCapability("set_feature_gate")!;
    const ctx = { uid: "uid_owner", email: "", displayName: "Owner", agencyId: "ag_1" };
    await cap.execute(ctx, { subAccountId: SA, subAccountName: "Fixture", gate: "prospecting", enabled: true });
    expect(sub().prospectingEnabledByAgency).toBe(true);
  }, 20_000);
});

describe("prospectingReportQuota", () => {
  it("stores an integer in 0–1000, bounds included", async () => {
    expect(await patch({ prospectingReportQuota: 0 })).toBe(200);
    expect(sub().prospectingReportQuota).toBe(0);
    expect(await patch({ prospectingReportQuota: 1000 })).toBe(200);
    expect(sub().prospectingReportQuota).toBe(1000);
    expect(await patch({ prospectingReportQuota: 75 })).toBe(200);
    expect(sub().prospectingReportQuota).toBe(75);
  });

  it.each([[-1], [1001], [2.5], ["50"], [null], [true]])(
    "refuses %s with 400 and writes nothing",
    async (bad) => {
      mem.seed(`subAccounts/${SA}`, { ...sub(), prospectingReportQuota: 40 });
      expect(await patch({ prospectingReportQuota: bad, prospectingEnabled: true })).toBe(400);
      expect(sub().prospectingReportQuota).toBe(40);
      expect(sub().prospectingEnabledByAgency).toBeUndefined();
    },
  );

  it("only the agency owner may set it", async () => {
    expect(await patch({ prospectingReportQuota: 10 }, "uid_admin")).toBe(403);
    expect(sub().prospectingReportQuota).toBeUndefined();
  });
});

describe("prospectingDailyFirstTouchCap", () => {
  it("stores an integer in 0–1000, bounds included", async () => {
    expect(await patch({ prospectingDailyFirstTouchCap: 0 })).toBe(200);
    expect(sub().prospectingDailyFirstTouchCap).toBe(0);
    expect(await patch({ prospectingDailyFirstTouchCap: 1000 })).toBe(200);
    expect(sub().prospectingDailyFirstTouchCap).toBe(1000);
    expect(await patch({ prospectingDailyFirstTouchCap: 5 })).toBe(200);
    expect(sub().prospectingDailyFirstTouchCap).toBe(5);
  });

  it.each([[-1], [1001], [2.5], ["20"], [null], [true]])(
    "refuses %s with 400 and writes nothing",
    async (bad) => {
      mem.seed(`subAccounts/${SA}`, { ...sub(), prospectingDailyFirstTouchCap: 12 });
      expect(await patch({ prospectingDailyFirstTouchCap: bad, prospectingEnabled: true })).toBe(400);
      expect(sub().prospectingDailyFirstTouchCap).toBe(12);
      expect(sub().prospectingEnabledByAgency).toBeUndefined();
    },
  );

  it("only the agency owner may set it", async () => {
    expect(await patch({ prospectingDailyFirstTouchCap: 10 }, "uid_admin")).toBe(403);
    expect(sub().prospectingDailyFirstTouchCap).toBeUndefined();
  });
});
