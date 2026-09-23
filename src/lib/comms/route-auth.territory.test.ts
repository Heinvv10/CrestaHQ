import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * requireContactAccessible is the gate for every comms send route, WhatsApp
 * media, and scheduled messages. It must apply the `contacts` read rule's
 * territory clause (canSeeScopedDoc), not just sub-account membership. The
 * real territory-filter runs here — only Firestore and Auth are faked.
 */

const mem = createMemoryFirestore();
const claims = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async () => ({ customClaims: claims.value }) }),
}));

const { requireContactAccessible } = await import("./route-auth");

function seedContact(id: string, territoryId: string | null) {
  mem.seed(`contacts/${id}`, { agencyId: "ag1", subAccountId: "sa1", name: id, territoryId });
}
function seedMember(role: string, assignedTerritoryIds: string[] = ["t1"]) {
  mem.seed("subAccounts/sa1/subAccountMembers/u1", { status: "active", role, assignedTerritoryIds });
}
async function statusFor(contactId: string): Promise<number> {
  const r = await requireContactAccessible("u1", contactId);
  return r instanceof NextResponse ? r.status : 200;
}

beforeEach(() => {
  mem.clear();
  claims.value = { status: "active", agencyId: "ag1", agencyRole: "staff" };
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  seedContact("in", "t1");
  seedContact("out", "t2");
  seedContact("glob", "global");
  seedContact("untagged", null);
  seedMember("collaborator");
});

describe("requireContactAccessible — territory scoping", () => {
  it("refuses a scoped collaborator a contact outside their territories", async () => {
    expect(await statusFor("out")).toBe(403);
  });

  it("refuses an untagged contact, as the read rule does (territoryId != null)", async () => {
    expect(await statusFor("untagged")).toBe(403);
  });

  it("allows their own territory and the Global pool", async () => {
    expect(await statusFor("in")).toBe(200);
    expect(await statusFor("glob")).toBe(200);
  });

  it("does not scope a sub-account admin", async () => {
    seedMember("admin", []);
    expect(await statusFor("out")).toBe(200);
    expect(await statusFor("untagged")).toBe(200);
  });

  it("does not scope the agency owner", async () => {
    claims.value = { status: "active", agencyId: "ag1", agencyRole: "owner" };
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
    seedContact("out", "t2");
    expect(await statusFor("out")).toBe(200);
  });

  it("does not scope anyone when the sub-account has scoping off", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: false });
    expect(await statusFor("out")).toBe(200);
  });
});
