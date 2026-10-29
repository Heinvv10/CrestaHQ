import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/agency/sub-accounts/[id]/feature-gates — the X0 gates
 * (`agentsEnabled` / `sellOnlineEnabled` / `aiOutboundSmsEnabled` →
 * `…EnabledByAgency`). Real tenancy, real gate service, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/automations/qstash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automations/qstash")>()),
  qstashIsConfigured: () => true,
}));

import { SA, claims, mem, resetSync } from "@/test/gbp-sync-harness";
import { seedAiSmsReady } from "@/test/ai-outbound-sms-fixture";
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

  it("rejects a non-boolean value with 400 and writes nothing", async () => {
    expect((await patch({ [key]: "true" })).status).toBe(400);
    expect(doc()?.[field]).toBeUndefined();
  });
});

describe("aiOutboundSmsEnabled", () => {
  /** Every readiness check passes; the gate itself is still off. */
  function ready() {
    vi.stubEnv("OPENROUTER_API_KEY", "or-test");
    seedAiSmsReady(mem.seed, SA, { ...doc(), aiOutboundSmsEnabledByAgency: false });
  }

  it("refuses to enable with a 409 naming the first unmet prerequisite, and writes nothing", async () => {
    const res = await patch({ aiOutboundSmsEnabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^AI texts can't be enabled yet: ai is configured on this deployment is missing/);
    expect(doc()?.aiOutboundSmsEnabledByAgency).toBeUndefined();
  });

  it("enables once every readiness check passes", async () => {
    ready();
    const res = await patch({ aiOutboundSmsEnabled: true });
    expect(res.status).toBe(200);
    expect(doc()?.aiOutboundSmsEnabledByAgency).toBe(true);
  });

  it("refuses when one check fails though the rest pass (SMS agent switched off)", async () => {
    ready();
    mem.seed(`subAccounts/${SA}/aiAgent/sms`, { ...mem.read(`subAccounts/${SA}/aiAgent/sms`), enabled: false });
    const res = await patch({ aiOutboundSmsEnabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/the sms ai agent is switched on is missing/);
    expect(doc()?.aiOutboundSmsEnabledByAgency).toBe(false);
  });

  it("refuses when the same request switches SMS AI auto-reply off", async () => {
    ready();
    const res = await patch({ aiOutboundSmsEnabled: true, smsAgentEnabled: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/sms ai auto-reply is allowed is missing/);
    expect(doc()?.aiOutboundSmsEnabledByAgency).toBe(false);
    expect(doc()?.smsAgentEnabledByAgency).toBeUndefined();
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
