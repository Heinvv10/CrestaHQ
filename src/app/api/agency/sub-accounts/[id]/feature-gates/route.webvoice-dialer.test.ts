import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/agency/sub-accounts/[id]/feature-gates — the Web Voice and
 * browser dialer gates (`webVoiceEnabled` / `dialerEnabled` → `…EnabledByAgency`).
 * Real tenancy, real gate service, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, claims, mem, resetSync } from "@/test/gbp-sync-harness";
import { PLAN_GATE_KEYS, PLAN_GATE_LABELS } from "@/types/billing";
import { FEATURE_GATES } from "@/lib/ai-suite/capabilities/helpers";
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

const doc = () => mem.read(`subAccounts/${SA}`);

beforeEach(() => {
  resetSync();
  claims.set("uid_owner", { status: "active", agencyId: "ag_1", agencyRole: "owner" });
});
afterEach(() => vi.restoreAllMocks());

describe.each([
  ["webVoiceEnabled", "webVoiceEnabledByAgency", "dialerEnabledByAgency"],
  ["dialerEnabled", "dialerEnabledByAgency", "webVoiceEnabledByAgency"],
] as const)("%s", (key, field, other) => {
  it("only the agency owner may change it", async () => {
    expect(await patch({ [key]: true }, "uid_admin")).toBe(403);
    expect(doc()?.[field]).toBeUndefined();
  });

  it("sets and clears the gate without touching the other one", async () => {
    const otherBefore = doc()?.[other];
    expect(await patch({ [key]: true })).toBe(200);
    expect(doc()?.[field]).toBe(true);
    expect(await patch({ [key]: false })).toBe(200);
    expect(doc()?.[field]).toBe(false);
    expect(doc()?.[other]).toBe(otherBefore);
  });

  it("is a standalone gate: not a plan gate", () => {
    expect(PLAN_GATE_KEYS).not.toContain(field);
    expect(Object.keys(PLAN_GATE_LABELS)).not.toContain(field);
  });
});

describe("FEATURE_GATES", () => {
  it.each([
    ["web-voice", "webVoiceEnabledByAgency"],
    ["dialer", "dialerEnabledByAgency"],
  ])("%s maps to %s and the assistant may never enable it", (name, field) => {
    expect(FEATURE_GATES[name]).toMatchObject({ field, assistantMayEnable: false });
  });
});
