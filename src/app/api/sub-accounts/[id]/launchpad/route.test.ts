import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The launchpad counts route, driven for real — through the real
 * `whatsappSenderConfigured()` seam. The load-bearing case: a Twilio-only
 * workspace has neither `whatsappCloudMeta` nor `whatsappBridgeMeta`, so a
 * route that inspected those fields directly (the bug PR #156 review caught)
 * would report it as never set up. This must go red if the route regresses
 * to that two-rail check.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({
    uid: "u1",
    agencyId: "ag1",
    subAccountId: "sa1",
    subAccountRole: "admin",
  }),
}));

const { GET } = await import("./route");

function seedSub(fields: Record<string, unknown>) {
  mem.seed("subAccounts/sa1", { agencyId: "ag1", ...fields });
}

async function counts() {
  const res = await GET(new Request("http://x/api"), {
    params: Promise.resolve({ id: "sa1" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    contacts: number;
    forms: number;
    activeWorkflows: number;
    bookingPages: number;
    googleCalendarConnected: boolean;
    whatsappConnected: boolean;
  };
}

beforeEach(() => {
  mem.clear();
});

describe("whatsappConnected", () => {
  it("is true on a Twilio-only workspace (no Cloud/bridge meta at all)", async () => {
    seedSub({
      whatsappProvider: "twilio",
      twilioConfig: { whatsappFromNumber: "+27110000000" },
    });
    expect((await counts()).whatsappConnected).toBe(true);
  });

  it("is true on a connected Cloud workspace", async () => {
    seedSub({
      whatsappProvider: "cloud",
      whatsappCloudMeta: { phoneNumberId: "123", displayPhoneNumber: "+27110000001" },
    });
    expect((await counts()).whatsappConnected).toBe(true);
  });

  it("is true on a paired bridge workspace", async () => {
    seedSub({
      whatsappProvider: "bridge",
      whatsappBridgeMeta: { displayPhoneNumber: "+27784356159" },
    });
    expect((await counts()).whatsappConnected).toBe(true);
  });

  it("is false with no rail configured", async () => {
    seedSub({});
    expect((await counts()).whatsappConnected).toBe(false);
  });

  it("does not credit another rail's leftover meta", async () => {
    // A workspace that migrated off Twilio to Cloud but never cleared the
    // legacy twilioConfig must not read as configured on the Cloud rail it
    // no longer has a number for.
    seedSub({
      whatsappProvider: "cloud",
      twilioConfig: { whatsappFromNumber: "+27110000000" },
      whatsappCloudMeta: { phoneNumberId: null, displayPhoneNumber: null },
    });
    expect((await counts()).whatsappConnected).toBe(false);
  });
});

describe("other counts", () => {
  it("counts contacts, forms and booking pages scoped to the sub-account", async () => {
    seedSub({});
    mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1" });
    mem.seed("contacts/c2", { subAccountId: "sa2", agencyId: "ag1" });
    mem.seed("forms/f1", { subAccountId: "sa1", agencyId: "ag1" });
    mem.seed("subAccounts/sa1/bookingPages/p1", { status: "published" });
    const result = await counts();
    expect(result.contacts).toBe(1);
    expect(result.forms).toBe(1);
    expect(result.bookingPages).toBe(1);
  });

  it("counts only active workflows", async () => {
    seedSub({});
    mem.seed("workflows/w1", { subAccountId: "sa1", status: "active" });
    mem.seed("workflows/w2", { subAccountId: "sa1", status: "draft" });
    mem.seed("workflows/w3", { subAccountId: "sa1", status: "paused" });
    expect((await counts()).activeWorkflows).toBe(1);
  });

  it("reports googleCalendarConnected when any member has a connected doc", async () => {
    seedSub({});
    mem.seed("subAccounts/sa1/private/googleCalendar_u1", { status: "revoked" });
    mem.seed("subAccounts/sa1/private/googleCalendar_u2", { status: "connected" });
    expect((await counts()).googleCalendarConnected).toBe(true);
  });

  it("reports googleCalendarConnected false when no member is connected", async () => {
    seedSub({});
    mem.seed("subAccounts/sa1/private/googleCalendar_u1", { status: "revoked" });
    expect((await counts()).googleCalendarConnected).toBe(false);
  });
});
