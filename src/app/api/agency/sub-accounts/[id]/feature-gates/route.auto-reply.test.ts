import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The review auto-reply gate (`reviewsAutoReplyEnabled` →
 * `reviewsAutoReplyEnabledByAgency`, AUTO_REPLY_V1_PLAN.md PR 1). Opt-in,
 * standalone (never a plan key), and the Workspace Assistant may switch it
 * off but never on. Real tenancy, real gate service, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, claims, mem, resetSync } from "@/test/gbp-sync-harness";
import { PLAN_GATE_KEYS, PLAN_GATE_LABELS } from "@/types/billing";
import { normalizePlanGates } from "@/lib/server/billing-lifecycle";
import { applyFeatureGates } from "@/lib/server/feature-gates-service";
import { getCapability } from "@/lib/ai-suite/capabilities";
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

const gate = () => mem.read(`subAccounts/${SA}`)?.reviewsAutoReplyEnabledByAgency;
const auditRows = () =>
  mem.list("auditEvents").filter((r) => r.action === "feature_gates.updated" && (r.target as { id?: string })?.id === SA);
const ctx = { uid: "uid_owner", email: "", displayName: "Owner", agencyId: "ag_1" };
const assistantArgs = (enabled: boolean) => ({ subAccountId: SA, subAccountName: "Fixture", gate: "reviews-auto-reply", enabled });

beforeEach(() => {
  resetSync();
  claims.set("uid_owner", { status: "active", agencyId: "ag_1", agencyRole: "owner" });
});
afterEach(() => vi.restoreAllMocks());

describe("reviewsAutoReplyEnabled (PATCH)", () => {
  it("only the agency owner may change it", async () => {
    expect(await patch({ reviewsAutoReplyEnabled: true }, "uid_admin")).toBe(403);
    expect(gate()).toBeUndefined();
  });

  it("writes the gate both ways, leaving the Reviews AI and Google gates alone", async () => {
    const before = mem.read(`subAccounts/${SA}`)!;
    expect(await patch({ reviewsAutoReplyEnabled: true })).toBe(200);
    expect(gate()).toBe(true);
    expect(await patch({ reviewsAutoReplyEnabled: false })).toBe(200);
    expect(gate()).toBe(false);
    const after = mem.read(`subAccounts/${SA}`)!;
    expect([after.reviewsAiEnabledByAgency, after.googleEnabledByAgency]).toEqual([before.reviewsAiEnabledByAgency, before.googleEnabledByAgency]);
  });

  it("switching it off tears nothing down — the sub-account's settings stay", async () => {
    const settings = { enabled: true, modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" }, includeBacklog: false };
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAutoReplyEnabledByAgency: true, reviewsAutoReply: settings });
    expect(await patch({ reviewsAutoReplyEnabled: false })).toBe(200);
    expect(mem.read(`subAccounts/${SA}`)?.reviewsAutoReply).toEqual(settings);
  });

  it("records an audit row with the boolean values, not REDACTED", async () => {
    expect(await patch({ reviewsAutoReplyEnabled: true })).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ changes: [{ field: "reviewsAutoReplyEnabledByAgency", before: false, after: true }] });
  });
});

describe("the Workspace Assistant (set_feature_gate)", () => {
  const cap = () => getCapability("set_feature_gate")!;

  it("validate refuses switching it on", () => {
    const v = cap().validate(assistantArgs(true));
    expect(v.ok).toBe(false);
    expect(gate()).toBeUndefined();
  });

  it("execute refuses switching it on, even without validate", async () => {
    await expect(cap().execute(ctx, assistantArgs(true))).rejects.toThrow(/only be switched on by the agency owner/);
    expect(gate()).toBeUndefined();
  }, 20_000);

  it("may switch it off", async () => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAutoReplyEnabledByAgency: true });
    expect(cap().validate(assistantArgs(false)).ok).toBe(true);
    await cap().execute(ctx, assistantArgs(false));
    expect(gate()).toBe(false);
  }, 20_000);

  it("other gates are still switchable on by the assistant", async () => {
    await cap().execute(ctx, { ...assistantArgs(true), gate: "reviews-ai" });
    expect(mem.read(`subAccounts/${SA}`)?.reviewsAiEnabledByAgency).toBe(true);
  }, 20_000);
});

describe("never a plan gate", () => {
  it("is not in PLAN_GATE_KEYS or its labels", () => {
    expect(PLAN_GATE_KEYS).not.toContain("reviewsAutoReplyEnabledByAgency");
    expect(Object.keys(PLAN_GATE_LABELS)).not.toContain("reviewsAutoReplyEnabledByAgency");
  });

  it("normalizePlanGates drops it, so applying a plan never touches a manual setting", async () => {
    const planGates = normalizePlanGates({ reviewsAutoReplyEnabledByAgency: true, reviewsAiEnabledByAgency: true });
    expect(Object.keys(planGates)).not.toContain("reviewsAutoReplyEnabledByAgency");
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAutoReplyEnabledByAgency: false });
    await applyFeatureGates(SA, planGates);
    expect(gate()).toBe(false);
  });
});
