import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The website-form channel of /api/sub-accounts/[id]/prospecting/mystery-shop
 * (PR 5c): the only allowed target is the latest ready report's lead-capture
 * formUrl, the POST queues the form job (202 queued) instead of sending, and
 * the GET sweep never calls a stuck form shop "sent" unless it reached the
 * submit. Real tenancy and transactions on the in-memory Firestore; channel
 * availability and QStash are faked (src/test/mystery-shop-route-harness.ts).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/automations/qstash", async () => (await import("@/test/mystery-shop-route-harness")).qstashMock());
vi.mock("@/lib/prospecting/mystery-shop/send", async () => (await import("@/test/mystery-shop-route-harness")).sendMock());

const { mem } = await import("@/test/gbp-sync-store");
const { EMAIL, OK, PHONE, USAGE, list, post, publish, resetRouteHarness, seedContact, seedSa, seedShop, send, shops, states, used } =
  await import("@/test/mystery-shop-route-harness");
const { FORM_STUCK_MS } = await import("@/lib/prospecting/mystery-shop/form/job-store");

const FORM = "https://www.acme.co.za/contact-us";
type Channels = Record<string, { available: boolean; reason?: string; targets: string[] }>;
let hash: Record<string, string>;

function seedReport(raw: Record<string, unknown> = { contactForm: false, formUrl: FORM }, extra: Record<string, unknown> = {}) {
  mem.seed("prospectReports/r1", {
    subAccountId: "sa1", contactId: "c1", status: "ready", sections: [{ key: "gbp", raw: {} }, { key: "lead_capture", raw }], ...extra,
  });
}
const get = async () => (await (await list()).json()) as { channels: Channels; enquiryHash: Record<string, string>; enquiry: { form: string } };
const formPost = (over: Record<string, unknown> = {}) =>
  post({ contactId: "c1", channel: "form", confirm: true, target: FORM, enquiryHash: hash.form, ...over });

beforeEach(async () => {
  await resetRouteHarness();
  states.mockResolvedValue({ email: OK, call: OK, whatsapp: OK, form: OK });
  seedReport();
  hash = (await get()).enquiryHash;
});

describe("GET: the form target", () => {
  it("is the latest ready report's formUrl, with the form enquiry and its own hash", async () => {
    const body = await get();
    expect(body.channels.form).toEqual({ available: true, targets: [FORM] });
    expect(body.enquiry.form).toContain("Do you do plumber in Gqeberha?");
    expect(hash.form).toMatch(/^[0-9a-f]{64}$/);
    expect(hash.form).not.toBe(hash.email);
  });

  it.each([
    ["a report from before formUrl was recorded", () => seedReport({ contactForm: true })],
    ["no lead-capture section", () => seedReport({}, { sections: [] })],
    ["a report that is not ready", () => seedReport(undefined, { status: "running" })],
    ["another contact's report", () => seedReport(undefined, { contactId: "c2" })],
    ["another sub-account's report", () => seedReport(undefined, { subAccountId: "sa2" })],
    ["no report at all", () => seedContact("c1", { prospecting: { category: "plumber" } })],
    ["a formUrl that is not http(s)", () => seedReport({ formUrl: "javascript:alert(1)" })],
  ])("%s → unavailable: generate a new report", async (_name, setup) => {
    setup();
    expect((await get()).channels.form).toEqual({
      available: false, reason: "Generate a new report to find the website's contact form.", targets: [],
    });
  });

  it("a site with no form: no target (the card says so)", async () => {
    seedReport({ contactForm: false, formUrl: null });
    expect((await get()).channels.form).toEqual({ available: true, targets: [] });
  });

  it("the engine or mailbox state wins over the target", async () => {
    states.mockResolvedValue({ email: OK, call: OK, whatsapp: OK, form: { available: false, reason: "The form engine isn't installed on this server." } });
    expect((await get()).channels.form).toEqual({ available: false, reason: "The form engine isn't installed on this server.", targets: [] });
  });
});

describe("POST channel form: refusals", () => {
  it("403 channel_unavailable when the engine is missing", async () => {
    states.mockResolvedValue({ email: OK, call: OK, whatsapp: OK, form: { available: false, reason: "The form engine isn't installed on this server." } });
    const res = await formPost();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "channel_unavailable", error: "The form engine isn't installed on this server." });
    expect(shops()).toEqual([]);
  });

  it("403 channel_unavailable without a formUrl (an older report, or no form on the site)", async () => {
    seedReport({ contactForm: true });
    expect(await (await formPost()).json()).toEqual({
      code: "channel_unavailable", error: "Generate a new report to find the website's contact form.",
    });
    seedReport({ formUrl: null });
    expect(await (await formPost()).json()).toEqual({ code: "channel_unavailable", error: "No contact form was found on this business's website." });
    expect(shops()).toEqual([]);
  });

  it.each([
    "https://www.acme.co.za/contact-us/", "https://www.acme.co.za/contact-us?x=1", "http://www.acme.co.za/contact-us",
    "https://acme.co.za/contact-us", "https://www.acme.co.za/", "https://evil.example/contact-us", "javascript:alert(1)",
    "http://169.254.169.254/", EMAIL, PHONE, undefined, 42,
  ])("403 target_not_allowed for %j", async (target) => {
    const res = await formPost({ target });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "target_not_allowed" });
    expect(shops()).toEqual([]);
  });

  it("the same URL in another spelling is the same target", async () => {
    expect((await formPost({ target: "HTTPS://WWW.ACME.CO.ZA:443/contact-us" })).status).toBe(202);
  });

  it("409 enquiry_changed for another channel's hash or a stale one", async () => {
    for (const enquiryHash of [hash.email, "stale", undefined]) {
      expect(await (await formPost({ enquiryHash })).json()).toMatchObject({ code: "enquiry_changed" });
    }
    expect(shops()).toEqual([]);
  });

  it("409 shop_in_progress while a form shop is queued for the contact", async () => {
    seedShop("open", { channel: "form", target: FORM, status: "queued" });
    expect((await formPost()).status).toBe(409);
  });
});

describe("POST channel form: queued, not sent", () => {
  it("reserves the shop queued with its match set, charges the month and queues the form job — no send, no timer", async () => {
    const res = await formPost();
    expect(res.status).toBe(202);
    const { shopId } = (await res.json()) as { shopId: string };
    expect(send).not.toHaveBeenCalled();
    expect(used()).toBe(1);
    expect(mem.read(`mysteryShops/${shopId}`)).toMatchObject({
      channel: "form", status: "queued", target: FORM, targetLabel: FORM, sentAt: null,
      enquiryText: expect.stringContaining("Do you do plumber in Gqeberha?"),
      formEnquiry: { subject: "Enquiry: plumber in Gqeberha", service: "plumber", town: "Gqeberha" },
      matchDomains: ["acme.co.za"], matchNumbers: [PHONE], matchAddresses: [EMAIL],
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      pathname: "/api/automations/prospecting/mystery-shop-form", body: { shopId }, delaySeconds: 0,
      deduplicationId: `mystery_shop_form_${shopId}`,
    });
  });

  it("stores no town when the shown form enquiry does not name it (a required town field then refuses)", async () => {
    seedSa(true, { prospectingMysteryShopTemplates: { emailSubject: "Enquiry", emailBody: "Do you do {service}?" } });
    hash = (await get()).enquiryHash;
    const { shopId } = (await (await formPost()).json()) as { shopId: string };
    expect(mem.read(`mysteryShops/${shopId}`)?.formEnquiry).toEqual({ subject: "Enquiry", service: "plumber", town: null });
  });

  it("a job QStash would not take: 502, the shop failed and its slot back", async () => {
    publish.mockResolvedValueOnce(null);
    const res = await formPost();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "send_failed" });
    expect(shops()[0]).toMatchObject({ status: "failed" });
    expect(used()).toBe(0);
  });
});

describe("GET sweep: a stuck form shop", () => {
  const old = new Date(Date.now() - FORM_STUCK_MS - 60_000);
  it("that never reached the submit is failed and refunded — not an uncertain send", async () => {
    mem.seed(USAGE, { mysteryShops: 1 });
    seedShop("f1", { channel: "form", target: FORM, status: "queued", sentAt: null, createdAt: old });
    await list();
    expect(mem.read("mysteryShops/f1")).toMatchObject({ status: "failed", failure: { code: "engine_stuck" } });
    expect(used()).toBe(0);
  });

  it("that reached the submit is an uncertain send", async () => {
    mem.seed(USAGE, { mysteryShops: 1 });
    seedShop("f1", { channel: "form", target: FORM, status: "queued", sentAt: null, createdAt: old, formStartedAt: old, formSubmitAt: old });
    await list();
    expect(mem.read("mysteryShops/f1")).toMatchObject({ status: "sent", sendUncertain: true });
    expect(used()).toBe(1);
  });

  it("is left alone while it may still be waiting for the box (the email 10-minute rule does not apply)", async () => {
    seedShop("f1", { channel: "form", target: FORM, status: "queued", sentAt: null, createdAt: new Date(Date.now() - 20 * 60_000) });
    await list();
    expect(mem.read("mysteryShops/f1")?.status).toBe("queued");
  });
});
