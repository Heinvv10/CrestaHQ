import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";

/**
 * GET /api/agency/sub-accounts/[id]/usage — the Manage dialog's usage
 * section. The overage line is valued whenever rates are set, as before;
 * the usage-charge preview (`rebilling.previewCents`) only while the client
 * is rebilled (agency switch AND client switch, both read fresh). The
 * currency is the plan's, else the payment provider's — never a hard-coded "usd".
 * Real route, real tenancy, real meter, in-memory Firestore.
 */

const mem = vi.hoisted(() => ({ ref: null as ReturnType<typeof createMemoryFirestore> | null }));
const claims: Record<string, Record<string, unknown>> = {
  uid_owner: { status: "active", agencyId: "ag_1", agencyRole: "owner" },
  uid_admin: { status: "active", agencyId: "ag_1", agencyRole: null },
  uid_other_owner: { status: "active", agencyId: "ag_2", agencyRole: "owner" },
};
vi.mock("@/lib/firebase/admin", async () => {
  const { createMemoryFirestore: make } = await import("@/test/memory-firestore");
  mem.ref = make();
  return {
    getAdminDb: () => mem.ref!.db,
    getAdminAuth: () => ({
      getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }),
    }),
  };
});

const { GET } = await import("./route");
const { usageMonthKey } = await import("@/lib/server/usage-meter");

restoreBillingProviderAfterEach();

const db = () => mem.ref!;
// A fresh id per test: the meter caches each sub-account's doc for 5 minutes.
let n = 0;
let SA = "";

interface Body {
  currency: string;
  overage: { perUnit: Record<string, { overUnits: number; cents: number }>; totalCents: number };
  rebilling: { active: boolean; agency: boolean; client: boolean; previewCents: number | null };
}

async function get(uid = "uid_owner") {
  return GET(
    new Request(`http://127.0.0.1:3100/api/agency/sub-accounts/${SA}/usage`, {
      headers: { "x-user-uid": uid },
    }),
    { params: Promise.resolve({ id: SA }) },
  );
}

function seed(opts: { agency?: boolean; client?: boolean; billing?: Record<string, unknown> } = {}) {
  db().seed("agencies/ag_1", { name: "Agency", ...(opts.agency !== undefined ? { usageRebillingEnabled: opts.agency } : {}) });
  db().seed(`subAccounts/${SA}`, {
    agencyId: "ag_1",
    name: "Fixture",
    usageQuotas: { smsSegmentsPerMonth: 100 },
    usageRates: { smsSegmentCents: 50 },
    ...(opts.client !== undefined ? { usageRebillingEnabled: opts.client } : {}),
    ...(opts.billing ? { billing: opts.billing } : {}),
  });
  // 20 segments over x 50c = 1,000 minor units.
  db().seed(`subAccounts/${SA}/usage/${usageMonthKey()}`, { smsSegments: 120 });
}

beforeEach(() => {
  db().clear();
  SA = `sa_${++n}`;
  spyBillingProvider("paystack");
});

const OVERAGE = { perUnit: { smsSegments: { overUnits: 20, cents: 1000 } }, totalCents: 1000 };

describe("the usage-charge preview needs both rebilling switches", () => {
  it.each<[string, { agency?: boolean; client?: boolean }]>([
    ["neither switch", {}],
    ["the agency switch only", { agency: true }],
    ["the client switch only", { client: true }],
    ["both explicitly off", { agency: false, client: false }],
  ])("%s → no preview, the overage line as before", async (_label, flags) => {
    seed(flags);
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.overage).toEqual(OVERAGE);
    expect(body.rebilling).toEqual({
      active: false,
      agency: flags.agency === true,
      client: flags.client === true,
      previewCents: null,
    });
  });

  it("both on → the preview is the overage total", async () => {
    seed({ agency: true, client: true });
    const body = (await (await get()).json()) as Body;
    expect(body.overage).toEqual(OVERAGE);
    expect(body.rebilling).toEqual({ active: true, agency: true, client: true, previewCents: 1000 });
  });

  it("both on with nothing over → a preview of zero, not none", async () => {
    seed({ agency: true, client: true });
    db().seed(`subAccounts/${SA}/usage/${usageMonthKey()}`, { smsSegments: 100 });
    const body = (await (await get()).json()) as Body;
    expect(body.overage.totalCents).toBe(0);
    expect(body.rebilling.previewCents).toBe(0);
  });

  it("a flip of the agency switch shows on the next read (no stale cache)", async () => {
    seed({ agency: true, client: true });
    expect(((await (await get()).json()) as Body).rebilling.previewCents).toBe(1000);
    db().seed("agencies/ag_1", { name: "Agency", usageRebillingEnabled: false });
    const body = (await (await get()).json()) as Body;
    expect(body.rebilling).toMatchObject({ active: false, previewCents: null });
    expect(body.overage).toEqual(OVERAGE);
  });
});

describe("currency", () => {
  it("Paystack provider, no plan currency → ZAR", async () => {
    seed({ agency: true, client: true });
    expect(((await (await get()).json()) as Body).currency).toBe("zar");
  });

  it("Stripe provider, no plan currency → USD (Stripe's own default)", async () => {
    spyBillingProvider("stripe");
    seed({ agency: true, client: true });
    expect(((await (await get()).json()) as Body).currency).toBe("usd");
  });

  it.each(["stripe", "paystack"] as const)("on %s a client's plan currency wins", async (kind) => {
    spyBillingProvider(kind);
    seed({ agency: true, client: true, billing: { currency: "eur" } });
    expect(((await (await get()).json()) as Body).currency).toBe("eur");
  });
});

describe("access", () => {
  it.each([
    ["a sub-account admin", "uid_admin"],
    ["another agency's owner", "uid_other_owner"],
  ])("%s is refused", async (_label, uid) => {
    seed({ agency: true, client: true });
    const res = await get(uid);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("1000");
  });
});
