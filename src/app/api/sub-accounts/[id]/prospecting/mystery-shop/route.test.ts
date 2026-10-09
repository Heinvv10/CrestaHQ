import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/sub-accounts/[id]/prospecting/mystery-shop — refusals, cap and send.
 * Real tenancy and transactions on the in-memory Firestore; only the send
 * seam and QStash are faked (src/test/mystery-shop-route-harness.ts).
 * Uncertain sends, the enquiry hash, consent and the GET sweeps:
 * route.integrity.test.ts.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/automations/qstash", async () => (await import("@/test/mystery-shop-route-harness")).qstashMock());
vi.mock("@/lib/prospecting/mystery-shop/send", async () => (await import("@/test/mystery-shop-route-harness")).sendMock());

const { mem } = await import("@/test/gbp-sync-store");
const {
  EMAIL, NOT_YET, OK, PHONE, USAGE, list, post, postRaw, publish, resetRouteHarness, seedContact, seedSa, seedShop,
  send, shops, states, used, valid,
} = await import("@/test/mystery-shop-route-harness");

beforeEach(resetRouteHarness);

describe("POST refusals, in order", () => {
  it("400: bad JSON, bad contactId, unknown channel", async () => {
    expect((await postRaw("{nope")).status).toBe(400);
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
      seedContact(`c_${status}`);
      seedShop(`done_${status}`, { status, contactId: `c_${status}` });
      expect((await post(valid({ contactId: `c_${status}` }))).status).toBe(202);
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

  it("a provider that definitely did not take it is 502 with a fixed message (the real reason logged), stored failed, not counted", async () => {
    mem.seed(USAGE, { mysteryShops: 9 });
    send.mockResolvedValueOnce({ ok: false, kind: "failed", reason: "535 auth failed for user secret@host" });
    const res = await post(valid());
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ code: "send_failed", error: "The enquiry could not be sent. Check the channel's settings and try again." });
    expect(body).not.toContain("535");
    expect(shops()[0]).toMatchObject({ status: "failed", failure: { code: "send_failed" } });
    expect(JSON.stringify(shops()[0])).not.toContain("535");
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.stringContaining("535"));
    expect(used()).toBe(9);
    // The slot is back: the 10th still goes out.
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
      niche: "plumber", createdByUid: "admin1", failure: null, targetDomainTrusted: true,
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

  it("a call goes to the E.164 number with the call enquiry and the operator's consent", async () => {
    const res = await post(valid({ channel: "call", target: "082 123 4567" }));
    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ channel: "call", target: PHONE, consentAck: true }));
    expect(shops()[0].targetDomainTrusted).toBe(false);
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
  it("lists the contact's shops newest first, with channels, targets, cap, use, the enquiry and its hash", async () => {
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
        whatsapp: { available: false, reason: "Not available yet.", targets: [PHONE] },
        form: { available: false, reason: "Not available yet.", targets: [] },
      },
      // No WhatsApp template in this sub-account: no WhatsApp enquiry.
      enquiry: { email: { subject: "Enquiry: plumber in Gqeberha" }, whatsapp: null },
      enquiryHash: { email: expect.stringMatching(/^[0-9a-f]{64}$/), call: expect.stringMatching(/^[0-9a-f]{64}$/), whatsapp: null },
    });
    expect(body).not.toHaveProperty("text");
  });

  it("is gated, and 404s another sub-account's contact", async () => {
    expect((await list("cOther")).status).toBe(404);
    seedSa(false);
    expect((await list()).status).toBe(403);
  });
});
