import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST …/mystery-shop/[shopId]/confirm-missed — a member's confirmation that
 * makes a missed shop public. Real tenancy and transactions, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem, claims } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");

const confirm = (shopId: string, uid = "admin1", body?: unknown) =>
  POST(
    new Request(`https://app.test/api/sub-accounts/sa1/prospecting/mystery-shop/${shopId}/confirm-missed`, {
      method: "POST",
      headers: { "x-user-uid": uid },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  it("WhatsApp: 409 not_delivered without a receipt, opted_out after STOP, review_auto_reply until the thread was read", async () => {
    const wa = (id: string, extra: Record<string, unknown>) =>
      mem.seed(`mysteryShops/${id}`, { agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "whatsapp", status: "missed", ...extra });
    const DELIVERED = { deliveredAt: new Date() };
    wa("w0", {});
    wa("w1", { ...DELIVERED, optOutAt: new Date() });
    wa("w2", { ...DELIVERED, autoReplyAt: new Date() });
    const expect409 = async (id: string, code: string, error: string, body?: unknown) => {
      const res = await confirm(id, "admin1", body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ code, error });
      expect(shop(id).missedConfirmedAt).toBeUndefined();
    };
    await expect409("w0", "not_delivered", "WhatsApp never confirmed this message was delivered, so it can't be published as a missed lead.");
    await expect409("w1", "opted_out", "The business replied STOP.");
    const REVIEW = "A reply arrived that looked automatic — read the WhatsApp thread before confirming.";
    await expect409("w2", "review_auto_reply", REVIEW);
    await expect409("w2", "review_auto_reply", REVIEW, { reviewedAutoReply: "yes" });
    expect((await confirm("w2", "admin1", { reviewedAutoReply: true })).status).toBe(200);
    wa("w3", { ...DELIVERED, replyNeedsReview: true });
    await expect409("w3", "review_reply", "A WhatsApp message from this number arrived — read the thread before confirming.");
    expect((await confirm("w3", "admin1", { reviewedAutoReply: true })).status).toBe(200);
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
