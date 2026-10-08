import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/sub-accounts/[id]/prospecting/mystery-shop. Real tenancy and real
 * transactions on the in-memory Firestore; only the send seam (channel
 * availability + the provider send) and the QStash publish are faked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const publish = vi.fn();
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: (...a: unknown[]) => publish(...a) }));
const send = vi.fn();
const states = vi.fn();
vi.mock("@/lib/prospecting/mystery-shop/send", () => ({
  sendMysteryShop: (...a: unknown[]) => send(...a),
  channelStates: (...a: unknown[]) => states(...a),
}));

const { mem, claims } = await import("@/test/gbp-sync-store");
const { usageMonthKey } = await import("@/lib/server/usage-meter");
const { GET, POST } = await import("./route");

const USAGE = `subAccounts/sa1/usage/${usageMonthKey()}`;
const EMAIL = "info@acme.co.za";
const PHONE = "+27821234567";
const OK = { available: true };
const NOT_YET = { available: false, reason: "Not available yet." };

const req = (method: string, path: string, body?: unknown, raw?: string) =>
  new Request(`https://app.test/api/sub-accounts/sa1/prospecting/mystery-shop${path}`, {
    method,
    headers: { "x-user-uid": "admin1", "content-type": "application/json" },
    ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = { params: Promise.resolve({ id: "sa1" }) };
const post = (body: unknown) => POST(req("POST", "", body), ctx);
const valid = (over: Record<string, unknown> = {}) => ({ contactId: "c1", channel: "email", confirm: true, target: EMAIL, ...over });
const list = (contactId = "c1") => GET(req("GET", `?contactId=${contactId}`), ctx);
const shops = () => mem.list("mysteryShops");
const used = () => mem.read(USAGE)?.mysteryShops;

function seedSa(gate = true, extra: Record<string, unknown> = {}) {
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1", name: "Cresta HQ", prospectingEnabledByAgency: gate, defaultPhoneCountry: "ZA", ...extra,
  });
}
function seedShop(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`mysteryShops/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "email", target: EMAIL, status: "sent",
    sentAt: new Date(), respondedAt: null, responseMs: null, autoReplyAt: null, jobValueCents: 150_000,
    currency: "ZAR", enquiryText: "x", failure: null, createdAt: new Date(), usageMonth: usageMonthKey(),
    ...extra,
  });
}

beforeEach(() => {
  mem.clear();
  claims.clear();
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  publish.mockReset().mockResolvedValue({ messageId: "m1" });
  send.mockReset().mockResolvedValue({ ok: true, providerRef: "<abc@crestahq.com>" });
  states.mockReset().mockResolvedValue({ email: OK, call: OK, whatsapp: NOT_YET, form: NOT_YET });
  seedSa();
  mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
  claims.set("admin1", { status: "active", agencyId: "ag1", agencyRole: null });
  for (const c of ["c1", "c2"]) {
    mem.seed(`contacts/${c}`, {
      subAccountId: "sa1", agencyId: "ag1", name: "Acme", company: "Acme Plumbing", email: EMAIL, phone: "082 123 4567",
      city: "Gqeberha", prospecting: { category: "plumber", lastReportId: "r1" },
    });
  }
  mem.seed("contacts/cOther", { subAccountId: "sa2", agencyId: "ag1", email: EMAIL });
});

describe("POST refusals, in order", () => {
  it("400: bad JSON, bad contactId, unknown channel", async () => {
    expect((await POST(req("POST", "", undefined, "{nope"), ctx)).status).toBe(400);
    expect((await post(valid({ contactId: "a/b" }))).status).toBe(400);
    expect((await post(valid({ contactId: undefined }))).status).toBe(400);
    expect((await post(valid({ channel: "sms" }))).status).toBe(400);
    expect(shops()).toEqual([]);
  });

  it("403 gate_off while Prospecting is off", async () => {
    seedSa(false);
    const res = await post(valid());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Prospecting is locked by your agency.", code: "gate_off" });
    expect(send).not.toHaveBeenCalled();
  });

  it("404: another sub-account's contact is the same as a missing one", async () => {
    const other = await post(valid({ contactId: "cOther" }));
    const missing = await post(valid({ contactId: "nope" }));
    expect(other.status).toBe(404);
    expect(await other.text()).toBe(await missing.text());
  });

  it.each([[undefined], [false], ["true"], [1]])("403 confirm_required when confirm is %j", async (confirm) => {
    const res = await post(valid({ confirm }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "confirm_required" });
    expect(send).not.toHaveBeenCalled();
    expect(shops()).toEqual([]);
  });

  it("403 channel_unavailable with the reason; WhatsApp and form are not available yet", async () => {
    states.mockResolvedValue({ email: { available: false, reason: "Connect SMTP first." }, call: OK, whatsapp: NOT_YET, form: NOT_YET });
    const res = await post(valid());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "channel_unavailable", error: "Connect SMTP first." });
    for (const channel of ["whatsapp", "form"]) {
      const r = await post(valid({ channel, target: PHONE }));
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ code: "channel_unavailable", error: "Not available yet." });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("403 target_not_allowed for anything but the contact's own address or number", async () => {
    for (const body of [valid({ target: "boss@acme.co.za" }), valid({ target: undefined }), valid({ channel: "call", target: "+27821234568" })]) {
      const res = await post(body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "target_not_allowed" });
    }
    expect(send).not.toHaveBeenCalled();
    expect(used()).toBeUndefined();
  });

  it("409 shop_in_progress while a queued/sent shop is open for the contact on that channel", async () => {
    for (const status of ["queued", "sent"]) {
      seedShop("open", { status });
      const res = await post(valid());
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "shop_in_progress" });
    }
    expect(send).not.toHaveBeenCalled();
    // Another channel and another contact do not block.
    expect((await post(valid({ channel: "call", target: "0821234567" }))).status).toBe(202);
    expect((await post(valid({ contactId: "c2" }))).status).toBe(202);
  });

  it("a settled shop does not block a new one", async () => {
    for (const status of ["responded", "missed", "failed", "refused"]) {
      mem.clear();
      seedSa();
      mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
      mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", email: EMAIL });
      seedShop("done", { status });
      expect((await post(valid())).status).toBe(202);
    }
  });

  it("concurrent POSTs for one contact + channel reserve exactly one shop", async () => {
    const all = await Promise.all(Array.from({ length: 4 }, () => post(valid())));
    expect(all.map((r) => r.status).sort()).toEqual([202, 409, 409, 409]);
    expect(used()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("cap", () => {
  it("the 10th shop is allowed, the 11th is 403 cap_reached", async () => {
    mem.seed(USAGE, { mysteryShops: 9 });
    expect((await post(valid())).status).toBe(202);
    expect(used()).toBe(10);
    const res = await post(valid({ contactId: "c2" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cap_reached" });
    expect(used()).toBe(10);
  });

  it("the agency owner's cap wins over the default", async () => {
    seedSa(true, { prospectingMysteryShopCap: 1 });
    mem.seed(USAGE, { mysteryShops: 1 });
    expect((await post(valid())).status).toBe(403);
  });

  it("a refused send is 403 with the compliance code, stored refused, and does not count", async () => {
    mem.seed(USAGE, { mysteryShops: 9 });
    send.mockResolvedValueOnce({ ok: false, kind: "refused", code: "outside_window", reason: "outside calling hours" });
    const res = await post(valid({ channel: "call", target: PHONE }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "outside_window", error: "outside calling hours" });
    expect(shops()[0]).toMatchObject({ status: "refused", failure: { code: "outside_window", reason: "outside calling hours" } });
    expect(used()).toBe(9);
    expect(publish).not.toHaveBeenCalled();
  });

  it("a provider failure is 502, stored failed, and does not count; a thrown send too", async () => {
    mem.seed(USAGE, { mysteryShops: 9 });
    send.mockResolvedValueOnce({ ok: false, kind: "failed", reason: "SMTP 554" });
    const res = await post(valid());
    expect(res.status).toBe(502);
    expect(shops()[0]).toMatchObject({ status: "failed", failure: { code: "send_failed", reason: "SMTP 554" } });
    expect(used()).toBe(9);
    send.mockRejectedValueOnce(new Error("boom"));
    expect((await post(valid())).status).toBe(502);
    expect(used()).toBe(9);
    // Both slots back: the 10th still goes out.
    expect((await post(valid())).status).toBe(202);
    expect(used()).toBe(10);
  });
});

describe("POST — send", () => {
  it("202: stores the shop, sends to the confirmed target and queues the 24 h + 30 min timer", async () => {
    const res = await post(valid({ target: " INFO@acme.co.za " }));
    expect(res.status).toBe(202);
    const { shopId } = (await res.json()) as { shopId: string };
    const shop = mem.read(`mysteryShops/${shopId}`)!;
    expect(shop).toMatchObject({
      agencyId: "ag1", subAccountId: "sa1", contactId: "c1", reportId: "r1", channel: "email", target: EMAIL,
      status: "sent", providerRef: "<abc@crestahq.com>", respondedAt: null, jobValueCents: 150_000, currency: "ZAR",
      niche: "plumber", createdByUid: "admin1", failure: null,
    });
    expect(shop.enquiryText).toBe(
      "Enquiry: plumber in Gqeberha\n\nHi,\n\nDo you do plumber in Gqeberha? What's your earliest availability?\n\nThanks,\nCresta HQ",
    );
    expect(shop.sentAt).toBeInstanceOf(Date);
    expect(used()).toBe(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ shopId, channel: "email", target: EMAIL, contactId: "c1", uid: "admin1" }));
    expect(publish).toHaveBeenCalledWith({
      pathname: "/api/automations/prospecting/mystery-shop",
      body: { shopId },
      delaySeconds: 88_200,
      deduplicationId: `mystery_shop_${shopId}`,
    });
  });

  it("a call goes to the E.164 number with the call enquiry", async () => {
    const res = await post(valid({ channel: "call", target: "082 123 4567" }));
    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ channel: "call", target: PHONE }));
    expect(shops()[0].enquiryText).toBe("Hi, I'm calling from Cresta HQ. Do you do plumber in Gqeberha? What's your earliest availability?");
  });

  it("a timer that cannot be queued still answers 202 and records timerError", async () => {
    publish.mockResolvedValueOnce(null);
    const res = await post(valid());
    expect(res.status).toBe(202);
    expect(shops()[0]).toMatchObject({ status: "sent", timerError: "The 24 h timer could not be queued." });
  });
});

describe("GET", () => {
  it("lists the contact's shops newest first, with channels, targets, cap, use and the enquiry", async () => {
    mem.seed(USAGE, { mysteryShops: 2 });
    seedShop("old", { status: "responded", createdAt: new Date("2026-09-01T00:00:00Z"), responseMs: 60_000 });
    seedShop("new", { createdAt: new Date() });
    seedShop("theirs", { contactId: "c2" });
    const res = await list();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { shops: { id: string; target: string }[] };
    expect(body.shops.map((s) => s.id)).toEqual(["new", "old"]);
    expect(body.shops[0].target).toBe(EMAIL);
    expect(body).toMatchObject({
      cap: 10,
      used: 2,
      channels: {
        email: { available: true, targets: [EMAIL] },
        call: { available: true, targets: [PHONE] },
        whatsapp: { available: false, reason: "Not available yet.", targets: [] },
        form: { available: false, reason: "Not available yet.", targets: [] },
      },
      enquiry: { email: { subject: "Enquiry: plumber in Gqeberha" } },
    });
  });

  it("settles a sent shop past 24 h + 30 min as missed and releases a stuck queued one; fresh ones are kept", async () => {
    mem.seed(USAGE, { mysteryShops: 4 });
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    seedShop("overdue", { sentAt: ago(24 * 60 + 31) });
    seedShop("graceLeft", { sentAt: ago(24 * 60 + 29) });
    seedShop("stuck", { status: "queued", sentAt: null, createdAt: ago(11) });
    seedShop("sending", { status: "queued", sentAt: null, createdAt: ago(1), contactId: "c1", channel: "call" });
    const body = (await (await list()).json()) as { shops: { id: string; status: string }[]; used: number };
    expect(Object.fromEntries(body.shops.map((s) => [s.id, s.status]))).toEqual({
      overdue: "missed", graceLeft: "sent", stuck: "failed", sending: "queued",
    });
    expect(used()).toBe(3);
    expect(body.used).toBe(3);
  });

  it("is gated, and 404s another sub-account's contact", async () => {
    expect((await list("cOther")).status).toBe(404);
    seedSa(false);
    expect((await list()).status).toBe(403);
  });
});
