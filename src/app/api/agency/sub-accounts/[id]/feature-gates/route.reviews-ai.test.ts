import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/agency/sub-accounts/[id]/feature-gates — the Reviews AI gate
 * (`reviewsAiEnabled` → `reviewsAiEnabledByAgency`, SP5 b). Opt-in, plan-
 * managed, no tear-down: switching it off leaves cached sentiment labels in
 * place. Real tenancy, real gate service, in-memory Firestore.
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

const gate = () => mem.read(`subAccounts/${SA}`)?.reviewsAiEnabledByAgency;

beforeEach(() => {
  resetSync();
  claims.set("uid_owner", { status: "active", agencyId: "ag_1", agencyRole: "owner" });
});
afterEach(() => vi.restoreAllMocks());

describe("reviewsAiEnabled", () => {
  it("only the agency owner may change it", async () => {
    expect(await patch({ reviewsAiEnabled: true }, "uid_admin")).toBe(403);
    expect(gate()).toBeUndefined();
  });

  it("writes the gate both ways, independently of the Google gate", async () => {
    const google = mem.read(`subAccounts/${SA}`)?.googleEnabledByAgency;
    expect(await patch({ reviewsAiEnabled: true })).toBe(200);
    expect(gate()).toBe(true);
    expect(await patch({ reviewsAiEnabled: false })).toBe(200);
    expect(gate()).toBe(false);
    expect(mem.read(`subAccounts/${SA}`)?.googleEnabledByAgency).toBe(google);
  });

  it("switching it off tears nothing down — a cached label stays", async () => {
    const path = `subAccounts/${SA}/gbpReviews/r1`;
    const sentiment = { label: "positive", method: "ai", basisHash: "h", model: "m", at: new Date() };
    mem.seed(path, { subAccountId: SA, state: "active", sentiment });
    expect(await patch({ reviewsAiEnabled: false })).toBe(200);
    expect(mem.read(path)?.sentiment).toEqual(sentiment);
  });

  it("the Workspace Assistant can flip it by name", async () => {
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const cap = getCapability("set_feature_gate")!;
    const ctx = { uid: "uid_owner", email: "", displayName: "Owner", agencyId: "ag_1" };
    await cap.execute(ctx, { subAccountId: SA, subAccountName: "Fixture", gate: "reviews-ai", enabled: true });
    expect(gate()).toBe(true);
  }, 20_000);

  it("is a plan gate, labelled", () => {
    expect(PLAN_GATE_KEYS).toContain("reviewsAiEnabledByAgency");
    expect(PLAN_GATE_LABELS.reviewsAiEnabledByAgency).toBe("Reviews AI (sentiment and reply drafts)");
  });
});
