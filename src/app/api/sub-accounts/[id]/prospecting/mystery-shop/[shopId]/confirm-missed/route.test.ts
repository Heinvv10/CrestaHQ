import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST …/mystery-shop/[shopId]/confirm-missed — a member's confirmation that
 * makes a missed shop public. Real tenancy and transactions, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem, claims } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");

const confirm = (shopId: string, uid = "admin1") =>
  POST(
    new Request(`https://app.test/api/sub-accounts/sa1/prospecting/mystery-shop/${shopId}/confirm-missed`, {
      method: "POST",
      headers: { "x-user-uid": uid },
    }),
    { params: Promise.resolve({ id: "sa1", shopId }) },
  );
const shop = (id: string) => mem.read(`mysteryShops/${id}`)!;

beforeEach(() => {
  mem.clear();
  claims.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
  mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
  claims.set("admin1", { status: "active", agencyId: "ag1", agencyRole: null });
  claims.set("stranger", { status: "active", agencyId: "ag1", agencyRole: null });
  mem.seed("mysteryShops/m1", { agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "email", status: "missed" });
  mem.seed("mysteryShops/r1", { agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "email", status: "responded" });
  mem.seed("mysteryShops/theirs", { agencyId: "ag1", subAccountId: "sa2", contactId: "c9", channel: "email", status: "missed" });
});

describe("confirm-missed", () => {
  it("stamps who confirmed and when; a repeat keeps the first confirmation", async () => {
    const res = await confirm("m1");
    expect(res.status).toBe(200);
    const first = shop("m1").missedConfirmedAt as Date;
    expect(first).toBeInstanceOf(Date);
    expect(shop("m1").missedConfirmedByUid).toBe("admin1");
    expect((await confirm("m1")).status).toBe(200);
    expect(shop("m1").missedConfirmedAt).toEqual(first);
  });

  it("409 not_missed for a shop that is not missed", async () => {
    const res = await confirm("r1");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "not_missed" });
    expect(shop("r1").missedConfirmedAt).toBeUndefined();
  });

  it("409 send_uncertain for a miss whose enquiry may never have been sent", async () => {
    mem.seed("mysteryShops/u1", { agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "email", status: "missed", sendUncertain: true });
    const res = await confirm("u1");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "send_uncertain", error: "This enquiry may not have been sent, so it can't be published as a missed lead.",
    });
    expect(shop("u1").missedConfirmedAt).toBeUndefined();
  });

  it("another sub-account's shop, a missing one and a bad id are the same 404", async () => {
    const theirs = await confirm("theirs");
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).toBe(await (await confirm("nope")).text());
    expect((await confirm("..")).status).toBe(404);
    expect(shop("theirs").missedConfirmedAt).toBeUndefined();
  });

  it("is gated, and members only", async () => {
    expect((await confirm("m1", "stranger")).status).toBe(403);
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: false });
    const off = await confirm("m1");
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: "gate_off" });
    expect(shop("m1").missedConfirmedAt).toBeUndefined();
  });
});
