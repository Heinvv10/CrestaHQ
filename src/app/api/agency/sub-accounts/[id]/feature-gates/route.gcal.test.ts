import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/agency/sub-accounts/[id]/feature-gates — the Google Calendar
 * gate (`googleCalendarEnabled` → `googleCalendarEnabledByAgency`). Real
 * tenancy, real gate service, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, claims, mem, resetSync } from "@/test/gbp-sync-harness";
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

const gate = () => mem.read(`subAccounts/${SA}`)?.googleCalendarEnabledByAgency;

beforeEach(() => {
  resetSync();
  claims.set("uid_owner", { status: "active", agencyId: "ag_1", agencyRole: "owner" });
});
afterEach(() => vi.restoreAllMocks());

describe("googleCalendarEnabled", () => {
  it("only the agency owner may change it", async () => {
    expect(await patch({ googleCalendarEnabled: true }, "uid_admin")).toBe(403);
    expect(gate()).toBeUndefined();
  });

  it("writes the gate both ways, independently of the Business Profile gate", async () => {
    const gbpBefore = mem.read(`subAccounts/${SA}`)?.googleEnabledByAgency;
    expect(await patch({ googleCalendarEnabled: true })).toBe(200);
    expect(gate()).toBe(true);
    expect(await patch({ googleCalendarEnabled: false })).toBe(200);
    expect(gate()).toBe(false);
    expect(mem.read(`subAccounts/${SA}`)?.googleEnabledByAgency).toBe(gbpBefore);
  });
});
