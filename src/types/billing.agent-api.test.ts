import { beforeEach, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * `agentApiEnabledByAgency` must stay a STANDALONE gate — never a plan key.
 * Reasoning (review finding on Agent API v1 PR1, 2026-09-24): as a plan key,
 * `create_billing_plan includeAllFeatures` would switch external agent
 * access on for every client on the plan, and applying a plan
 * (`normalizePlanGates` + `applyFeatureGates`) would silently overwrite a
 * manual enable/disable — the same treatment as `webinar1EnabledByAgency` /
 * `googleEnabledByAgency`.
 */

const mem = vi.hoisted(() => ({ ref: null as ReturnType<typeof createMemoryFirestore> | null }));
vi.mock("@/lib/firebase/admin", async () => {
  const { createMemoryFirestore: make } = await import("@/test/memory-firestore");
  mem.ref = make();
  return { getAdminDb: () => mem.ref!.db };
});

import { PLAN_GATE_KEYS, PLAN_GATE_LABELS } from "@/types/billing";
import { normalizePlanGates } from "@/lib/server/billing-lifecycle";
import { applyFeatureGates } from "@/lib/server/feature-gates-service";

const db = () => mem.ref!;
const SA = "sa_1";

beforeEach(() => {
  db().clear();
  db().seed(`subAccounts/${SA}`, { agencyId: "ag_1", agentApiEnabledByAgency: true });
});

it("is not a plan gate", () => {
  expect(PLAN_GATE_KEYS).not.toContain("agentApiEnabledByAgency");
  expect(Object.keys(PLAN_GATE_LABELS)).not.toContain("agentApiEnabledByAgency");
});

it("normalizePlanGates never produces the field, even if the input carries it", () => {
  const gates = normalizePlanGates({ agentApiEnabledByAgency: true, broadcastsEnabledByAgency: true });
  expect(Object.keys(gates)).not.toContain("agentApiEnabledByAgency");
});

it("applying a plan's gate bundle does not touch a manually-set agentApiEnabledByAgency", async () => {
  const planGates = normalizePlanGates({ broadcastsEnabledByAgency: true });
  await applyFeatureGates(SA, planGates);
  // The plan bundle never mentions the field, so the manual `true` set in
  // beforeEach must survive an activation untouched.
  expect(db().read(`subAccounts/${SA}`)?.agentApiEnabledByAgency).toBe(true);
  expect(db().read(`subAccounts/${SA}`)?.broadcastsEnabledByAgency).toBe(true);
});
