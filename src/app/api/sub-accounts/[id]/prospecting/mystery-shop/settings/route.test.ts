import { beforeEach, describe, expect, it, vi } from "vitest";

/** PUT …/prospecting/mystery-shop/settings — real tenancy, in-memory Firestore. */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem, claims } = await import("@/test/gbp-sync-store");
const { PUT } = await import("./route");

const put = (body: unknown, uid = "admin1", raw?: string) =>
  PUT(
    new Request("https://app.test/api/sub-accounts/sa1/prospecting/mystery-shop/settings", {
      method: "PUT",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "sa1" }) },
  );
const sub = () => mem.read("subAccounts/sa1") ?? {};

beforeEach(() => {
  mem.clear();
  claims.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
  mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
  mem.seed("subAccounts/sa1/subAccountMembers/collab1", { status: "active", role: "collaborator" });
  claims.set("admin1", { status: "active", agencyId: "ag1", agencyRole: null });
  claims.set("collab1", { status: "active", agencyId: "ag1", agencyRole: null });
});

describe("PUT", () => {
  it("stores normalised job values and templates", async () => {
    const res = await put({ jobValues: { "Hair Care": 80_000 }, templates: { emailSubject: " Hi {service} ", call: "" } });
    expect(res.status).toBe(200);
    expect(sub()).toMatchObject({
      prospectingJobValues: { hair_care: 80_000 },
      prospectingMysteryShopTemplates: { emailSubject: "Hi {service}" },
    });
  });

  it("one field left out is kept", async () => {
    await put({ jobValues: { plumber: 1 }, templates: { call: "Hi" } });
    await put({ jobValues: { plumber: 2 } });
    expect(sub()).toMatchObject({ prospectingJobValues: { plumber: 2 }, prospectingMysteryShopTemplates: { call: "Hi" } });
  });

  it.each([
    [{ jobValues: { plumber: 1.5 } }],
    [{ jobValues: { plumber: 100_000_001 } }],
    [{ jobValues: { ["x".repeat(61)]: 1 } }],
    [{ templates: { emailBody: "x".repeat(2001) } }],
    [{ templates: { other: "x" } }],
    [{ templates: { emailSubject: "Hi\r\nBcc: x@y.z" } }],
    [{}],
  ])("refuses %j with 400 and writes nothing", async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(sub().prospectingJobValues).toBeUndefined();
    expect(sub().prospectingMysteryShopTemplates).toBeUndefined();
  });

  it("whatsappTemplateId: one of this sub-account's WhatsApp templates, stored beside the wording; null goes back to the default", async () => {
    mem.seed("subAccounts/sa1/whatsappTemplates/t1", { subAccountId: "sa1", name: "my_enquiry" });
    await put({ templates: { call: "Hi" } });
    expect((await put({ whatsappTemplateId: "t1" })).status).toBe(200);
    expect(sub().prospectingMysteryShopTemplates).toEqual({ call: "Hi", whatsappTemplateId: "t1" });
    // Saving the wording keeps the template choice, and the reverse.
    await put({ templates: { call: "Hello" } });
    expect(sub().prospectingMysteryShopTemplates).toEqual({ call: "Hello", whatsappTemplateId: "t1" });
    expect((await put({ whatsappTemplateId: null })).status).toBe(200);
    expect(sub().prospectingMysteryShopTemplates).toEqual({ call: "Hello" });
  });

  it.each([["a/b"], ["t1/x/y"], [""], [123], [{ id: "t1" }], ["missing"], ["t9"]])(
    "refuses whatsappTemplateId %j (not a doc id, or no such template in THIS sub-account) with 400, writing nothing",
    async (whatsappTemplateId) => {
      mem.seed("subAccounts/sa2/whatsappTemplates/t9", { subAccountId: "sa2", name: "theirs" });
      // A path, not an id: it would reach a doc nested under a template.
      mem.seed("subAccounts/sa1/whatsappTemplates/t1/x/y", { subAccountId: "sa1", name: "nested" });
      const res = await put({ whatsappTemplateId, templates: { call: "Hi" } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Pick one of this sub-account's WhatsApp templates." });
      expect(sub().prospectingMysteryShopTemplates).toBeUndefined();
    },
  );

  it("refuses bad JSON, a collaborator, and a sub-account with Prospecting off", async () => {
    expect((await put(null, "admin1", "{nope")).status).toBe(400);
    expect((await put({ jobValues: { plumber: 1 } }, "collab1")).status).toBe(403);
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: false });
    const off = await put({ jobValues: { plumber: 1 } });
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: "gate_off" });
    expect(sub().prospectingJobValues).toBeUndefined();
  });
});
