import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mystery-shop route's WhatsApp channel (PR 5b) through the REAL send
 * seam (send.ts → whatsapp.ts → prepareWhatsappTemplateSend), on the
 * in-memory Firestore. Faked: the rail's readiness probe, the template send
 * itself (sendWhatsappTemplate — never a real message) and QStash.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/automations/qstash", async () => (await import("@/test/mystery-shop-route-harness")).qstashMock());
const readiness = vi.hoisted(() => vi.fn());
vi.mock("@/lib/comms/whatsapp/readiness", () => ({ checkWhatsappReadiness: (...a: unknown[]) => readiness(...a) }));
const waSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/whatsapp-template-send", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/whatsapp-template-send")>()),
  sendWhatsappTemplate: (...a: unknown[]) => waSend(...a),
}));

const { mem, storeDb } = await import("@/test/gbp-sync-store");
const { PHONE, USAGE, list, post, publish, readHashes, resetRouteHarness, seedContact, seedSa, shops, used, valid } =
  await import("@/test/mystery-shop-route-harness");

const TPL = "subAccounts/sa1/whatsappTemplates/t1";
const BODY = "Hi, do you offer {{1}} in {{2}}? What's your earliest availability?";
const TEXT = "Hi, do you offer plumber in Gqeberha? What's your earliest availability?";
const WAMID = "wamid.HBgLMjc4MjEyMzQ1NjcVAgARGBI";
const N = "The WhatsApp template leadstack_speed_check";
const variable = (position: number) => ({ position, label: `v${position}`, sampleValue: "x", source: "manual", mergeTag: null });
const cloud = (status: string, extra: Record<string, unknown> = {}) => ({
  registrations: { cloud: { externalId: "meta-1", status, rejectionReason: null, ...extra } },
});

function seedTemplate(extra: Record<string, unknown> = {}, path = TPL) {
  mem.seed(path, {
    subAccountId: "sa1", agencyId: "ag1", name: "leadstack_speed_check", displayName: "Speed check", category: "UTILITY",
    language: "en", body: BODY, variables: [variable(1), variable(2)], status: "approved", rejectionReason: null,
    contentSid: null, ...cloud("approved"), ...extra,
  });
}
const wa = (over: Record<string, unknown> = {}) => valid({ channel: "whatsapp", target: PHONE, ...over });
async function expectUnavailable(reason: string) {
  const body = (await (await list()).json()) as { channels: { whatsapp: { available: boolean; reason?: string } } };
  expect(body.channels.whatsapp).toMatchObject({ available: false, reason });
  const res = await post(wa());
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ code: "channel_unavailable", error: reason });
  expect(waSend).not.toHaveBeenCalled();
  expect(shops()).toEqual([]);
}

beforeEach(async () => {
  readiness.mockReset().mockResolvedValue({ ready: true, provider: "cloud", sender: { id: "default" } });
  waSend.mockReset().mockResolvedValue({ ok: true, sid: WAMID });
  await resetRouteHarness();
  seedSa(true, { whatsappEnabledByAgency: true, whatsappProvider: "cloud" });
  seedTemplate();
  await readHashes();
});

describe("WhatsApp: 403 channel_unavailable, naming why", () => {
  it("WhatsApp switched off by the agency", async () => {
    seedSa(true, { whatsappEnabledByAgency: false, whatsappProvider: "cloud" });
    await expectUnavailable("WhatsApp is disabled for this sub-account by your agency.");
  });

  it("no WhatsApp sender connected", async () => {
    readiness.mockResolvedValue({ ready: false, provider: "cloud", error: "WhatsApp Cloud isn't connected." });
    await expectUnavailable("No WhatsApp sender is connected.");
  });

  it("the default sender is not on the Cloud rail (whose inbound webhook times the reply)", async () => {
    readiness.mockResolvedValue({ ready: true, provider: "twilio", sender: { id: "default" } });
    await expectUnavailable("Mystery-shop WhatsApp needs a WhatsApp Cloud sender as the default: only its replies can be timed.");
  });

  it("the template is missing, by name or by the id chosen in settings", async () => {
    await mem.db.doc(TPL).delete();
    await expectUnavailable(`${N} doesn't exist yet: create it and submit it to Meta.`);
    seedTemplate();
    seedSa(true, { whatsappEnabledByAgency: true, whatsappProvider: "cloud", prospectingMysteryShopTemplates: { whatsappTemplateId: "gone" } });
    await expectUnavailable("The WhatsApp template chosen in Prospecting settings no longer exists.");
  });

  it.each([
    ["pending", cloud("pending"), `${N} is pending Meta approval.`],
    ["rejected", cloud("rejected", { rejectionReason: "INVALID_FORMAT" }), `${N} was rejected: INVALID_FORMAT.`],
    ["approved on Twilio only (not for the current rail)", { registrations: null, contentSid: "HX1" }, `${N} is approved on another WhatsApp account only, not on your Meta WhatsApp account.`],
    ["the wrong variable count", { variables: [variable(1)], body: "Do you offer {{1}}?" }, `${N} must have exactly two variables: {{1}} the service and {{2}} the town.`],
  ])("the template is %s", async (_name, over, reason) => {
    seedTemplate(over);
    await expectUnavailable(reason);
  });

  it("the template chosen in settings is used over the one named leadstack_speed_check", async () => {
    seedTemplate({ name: "my_enquiry", ...cloud("pending") }, "subAccounts/sa1/whatsappTemplates/t2");
    seedSa(true, { whatsappEnabledByAgency: true, whatsappProvider: "cloud", prospectingMysteryShopTemplates: { whatsappTemplateId: "t2" } });
    await expectUnavailable("The WhatsApp template my_enquiry is pending Meta approval.");
  });
});

describe("WhatsApp: the target", () => {
  it("403 target_not_allowed for any number but the contact's own; nothing reserved or sent", async () => {
    for (const target of ["+27821234568", "", undefined, "info@acme.co.za"]) {
      const res = await post(wa({ target }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "target_not_allowed" });
    }
    expect(waSend).not.toHaveBeenCalled();
    expect(used()).toBeUndefined();
  });

  it("the contact's number as stored (national format) is confirmed and sent as the same E.164 the route checked", async () => {
    expect(((await (await list()).json()) as { channels: { whatsapp: { targets: string[] } } }).channels.whatsapp.targets).toEqual([PHONE]);
    expect((await post(wa({ target: "082 123 4567" }))).status).toBe(202);
    expect(waSend.mock.calls[0][0].contact.phone).toBe(PHONE);
    expect(shops()[0].target).toBe(PHONE);
  });

  it("403 opted_out for a contact who opted out of WhatsApp: refused, the slot given back, nothing sent", async () => {
    seedContact("c1", { whatsappOptedOut: true });
    const res = await post(wa());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "opted_out", error: "This contact has opted out of WhatsApp." });
    expect(waSend).not.toHaveBeenCalled();
    expect(shops()[0]).toMatchObject({ status: "refused", failure: { code: "opted_out" } });
    expect(used()).toBe(0);
  });
});

describe("WhatsApp: the send", () => {
  it("202: the approved template to the target with {{1}} service and {{2}} town; the wamid is the providerRef; the timer is queued", async () => {
    const before = (await (await list()).json()) as { enquiry: { whatsapp: string }; enquiryHash: { whatsapp: string } };
    expect(before.enquiry.whatsapp).toBe(TEXT);
    expect(before.enquiryHash.whatsapp).toMatch(/^[0-9a-f]{64}$/);
    const res = await post(wa());
    expect(res.status).toBe(202);
    const call = waSend.mock.calls[0][0];
    expect(call).toMatchObject({ templateId: "t1", contactId: "c1", actorUid: "admin1", values: ["plumber", "Gqeberha"] });
    expect(call.tpl.name).toBe("leadstack_speed_check");
    expect(shops()[0]).toMatchObject({ channel: "whatsapp", status: "sent", target: PHONE, providerRef: WAMID, enquiryText: TEXT });
    expect(used()).toBe(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ body: { shopId: shops()[0].id } }));
  });

  it("no town: {{2}} reads 'your area' — never an empty parameter", async () => {
    seedContact("c1", { city: "  " });
    await readHashes();
    expect((await post(wa())).status).toBe(202);
    expect(waSend.mock.calls[0][0].values).toEqual(["plumber", "your area"]);
    expect(shops()[0].enquiryText).toBe("Hi, do you offer plumber in your area? What's your earliest availability?");
  });

  it("409 enquiry_changed for a missing or stale hash, e.g. after the template body changed", async () => {
    expect((await post(wa({ enquiryHash: undefined }))).status).toBe(409);
    seedTemplate({ body: "Hello! Do you offer {{1}} in {{2}}?" });
    const res = await post(wa());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "enquiry_changed" });
    expect(waSend).not.toHaveBeenCalled();
  });

  it("409 when the template was switched to another with the same words since the dialog opened", async () => {
    seedTemplate({}, "subAccounts/sa1/whatsappTemplates/t2");
    seedSa(true, { whatsappEnabledByAgency: true, whatsappProvider: "cloud", prospectingMysteryShopTemplates: { whatsappTemplateId: "t2" } });
    const res = await post(wa());
    expect(res.status).toBe(409);
    expect(waSend).not.toHaveBeenCalled();
  });

  it("409, nothing reserved, when the template vanished between the availability check and the enquiry", async () => {
    const real = storeDb.collection.bind(storeDb);
    let lookups = 0;
    vi.spyOn(storeDb, "collection").mockImplementation((path: string) =>
      path.endsWith("/whatsappTemplates") && ++lookups === 2 ? real("gone/x/whatsappTemplates") : real(path),
    );
    const res = await post(wa({ enquiryHash: undefined }));
    expect(lookups).toBe(2);
    expect(res.status).toBe(409);
    expect(shops()).toEqual([]);
  });

  it.each([
    ["Meta refused it outright (4xx)", { ok: false, status: 409, error: "WhatsApp Cloud 400: bad param", attempted: true, providerOutcome: "DEFINITELY_REJECTED" }],
    ["refused before the provider was asked", { ok: false, status: 409, error: "Template isn't approved." }],
  ])("a definite refusal — %s — is failed, the slot given back, 502 send_failed", async (_name, result) => {
    waSend.mockResolvedValue(result);
    const res = await post(wa());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "send_failed" });
    expect(shops()[0]).toMatchObject({ status: "failed" });
    expect(used()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ["an ambiguous provider answer (5xx / network)", () => waSend.mockResolvedValue({ ok: false, status: 409, error: "WhatsApp Cloud 503", attempted: true, providerOutcome: "AMBIGUOUS" })],
    ["a 502 from the send", () => waSend.mockResolvedValue({ ok: false, status: 502, error: "socket hang up" })],
    ["a throw", () => waSend.mockRejectedValue(new Error("boom"))],
    ["success without a message id", () => waSend.mockResolvedValue({ ok: true, sid: "" })],
  ])("an uncertain send — %s — stays sent + sendUncertain, keeps its slot and its timer, 502 send_uncertain", async (_name, arrange) => {
    arrange();
    const res = await post(wa());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "send_uncertain" });
    expect(shops()[0]).toMatchObject({ status: "sent", sendUncertain: true });
    expect(used()).toBe(1);
    expect(publish).toHaveBeenCalled();
    expect((await post(wa())).status).toBe(409);
  });

  it("409 shop_in_progress while a WhatsApp shop is open for the contact", async () => {
    expect((await post(wa())).status).toBe(202);
    const res = await post(wa());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "shop_in_progress" });
    expect(waSend).toHaveBeenCalledTimes(1);
    expect(mem.read(USAGE)?.mysteryShops).toBe(1);
  });
});
