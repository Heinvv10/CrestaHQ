import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/agency/sub-accounts/[id]/ai-outbound-sms-readiness — the Manage
 * dialog's AI texts checklist. Real tenancy and readiness, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/automations/qstash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automations/qstash")>()),
  qstashIsConfigured: () => true,
}));

import { SA, claims, mem, resetSync } from "@/test/gbp-sync-harness";
import { seedAiSmsReady } from "@/test/ai-outbound-sms-fixture";
import { storeDb } from "@/test/gbp-sync-store";
import { GET } from "./route";

async function get(uid = "uid_owner", id = SA) {
  const res = await GET(
    new Request(`http://127.0.0.1:3100/api/agency/sub-accounts/${id}/ai-outbound-sms-readiness`, {
      headers: { "x-user-uid": uid },
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  resetSync();
  claims.set("uid_owner", { status: "active", agencyId: "ag_1", agencyRole: "owner" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AI texts readiness", () => {
  it("lists every check, ready once all pass", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "or-test");
    seedAiSmsReady(mem.seed, SA, { ...mem.read(`subAccounts/${SA}`), aiOutboundSmsEnabledByAgency: false });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ gateOn: false, ready: true });
    expect((res.body.checks as unknown[]).length).toBe(6);
  });

  it("is not ready on a bare workspace and says what is missing", async () => {
    const res = await get();
    expect(res.body.ready).toBe(false);
    expect(res.body.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "twilio", ok: false })]),
    );
  });

  it("is agency owner only", async () => {
    expect((await get("uid_admin")).status).toBe(403);
  });

  it("refuses an id that is not a doc id before any read", async () => {
    const reads = vi.spyOn(storeDb, "doc");
    expect((await get("uid_owner", `${SA}/private/twilioCredentials`)).status).toBe(404);
    expect(reads).not.toHaveBeenCalled();
  });
});
