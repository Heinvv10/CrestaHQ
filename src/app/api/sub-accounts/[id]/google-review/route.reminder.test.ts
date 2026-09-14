import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP5 d2 — the reminder setting on the google-review config route, over REAL
 * require-tenancy and the in-memory Firestore. Off by default; a save that
 * does not mention reminders never changes them; only an admin may change
 * them; out-of-range values are refused.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { PATCH, POST } from "./route";

const REVIEW_URL = "https://g.page/r/fixture/review";
const DEDICATED = { enabled: true, accountSid: "AC_test", authToken: "tok", fromNumber: "+15017122661", inboundWebhookConfigured: true };
const cfg = () => mem.read(`subAccounts/${SA}`)?.googleReviewConfig as Record<string, unknown> | null | undefined;

function call(handler: typeof POST, method: string, body: Record<string, unknown>, uid = "uid_admin") {
  return handler(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/google-review`, uid, method, JSON.stringify(body)), {
    params: Promise.resolve({ id: SA }),
  });
}
const save = (extra: Record<string, unknown> = {}) =>
  call(POST, "POST", { enabled: false, reviewUrl: REVIEW_URL, channel: "sms", ...extra });

const ORIGINAL = { ...process.env };
beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-for-click-tokens";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, twilioConfig: DEDICATED });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("POST (the whole config)", () => {
  it("a save that never mentions reminders writes no reminder key — the stored config is as before", async () => {
    expect((await save()).status).toBe(200);
    expect(cfg()).not.toHaveProperty("reminder");
  });

  it("saves reminders when given, and a later save without them keeps them", async () => {
    expect((await save({ reminder: { everyDays: 3, maxRetries: 2 } })).status).toBe(200);
    expect(cfg()?.reminder).toEqual({ everyDays: 3, maxRetries: 2 });
    // The form's save does not touch it.
    expect((await save({ messageTemplate: "Hi {{firstName}}: {{reviewUrl}}" })).status).toBe(200);
    expect(cfg()?.reminder).toEqual({ everyDays: 3, maxRetries: 2 });
  });

  it("everyDays null is 'Don't repeat' (off)", async () => {
    await save({ reminder: { everyDays: null, maxRetries: 3 } });
    expect(cfg()?.reminder).toEqual({ everyDays: null, maxRetries: 3 });
  });

  it.each([
    [{ everyDays: 0, maxRetries: 2 }],
    [{ everyDays: 8, maxRetries: 2 }],
    [{ everyDays: 31, maxRetries: 2 }],
    [{ everyDays: 2.5, maxRetries: 2 }],
    [{ everyDays: 3, maxRetries: 0 }],
    [{ everyDays: 3, maxRetries: 6 }],
    [{ everyDays: "3", maxRetries: 2 }],
    ["on"],
  ])("refuses an out-of-range reminder %j", async (reminder) => {
    const res = await save({ reminder });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "reminder" });
    expect(cfg()).toBeUndefined();
  });
});

describe("enabling reminders has prerequisites (POST and PATCH)", () => {
  const on = { everyDays: 3, maxRetries: 2 };

  it("SMS only: a WhatsApp channel cannot have reminders turned on", async () => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, whatsappEnabledByAgency: false });
    for (const channel of ["whatsapp_manual", "whatsapp_template"]) {
      mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleReviewConfig: { reviewUrl: REVIEW_URL, channel } });
      const res = await call(PATCH, "PATCH", { reminder: on });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "reminders_sms_only" });
    }
  });

  it("a POST switching to WhatsApp with reminders on in the same body is refused", async () => {
    const res = await save({ reminder: on, channel: "whatsapp_manual" });
    expect([400, 403]).toContain(res.status);
    expect(cfg()).toBeUndefined();
  });

  it.each([["AUTOMATIONS_TOKEN_SECRET"], ["NEXT_PUBLIC_APP_URL"]])("needs link tracking: refused without %s", async (name) => {
    await save();
    delete process.env[name];
    const res = await call(PATCH, "PATCH", { reminder: on });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "reminders_need_tracking" });
    expect((await save({ reminder: on })).status).toBe(400);
    expect(cfg()).not.toHaveProperty("reminder");
  });

  it.each([
    ["https://g.page/r/abc/review", 200],
    ["https://search.google.com/local/writereview?placeid=abc", 200],
    ["https://maps.app.goo.gl/abc", 200],
    ["https://www.google.com/maps/place/x", 200],
    ["https://maps.google.com/?cid=1", 200],
    ["https://example.com/review", 400],
    ["https://g.page.evil.test/r/abc", 400],
  ])("only a Google review link can be repeated: %s → %i", async (url, status) => {
    const res = await save({ reviewUrl: url, reminder: on });
    expect(res.status).toBe(status);
  });

  it.each([
    ["no Twilio config (the shared sender)", null],
    ["dedicated SMS switched off", { ...DEDICATED, enabled: false }],
  ])("needs a dedicated SMS number: refused with %s", async (_l, twilioConfig) => {
    await save();
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, twilioConfig });
    const res = await call(PATCH, "PATCH", { reminder: on });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "reminders_need_dedicated_number" });
    expect((await save({ reminder: on })).status).toBe(400);
    expect(cfg()).not.toHaveProperty("reminder");
  });

  it("needs replies to reach us: refused while the number's inbound webhook isn't set up", async () => {
    await save();
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, twilioConfig: { ...DEDICATED, inboundWebhookConfigured: false } });
    const res = await call(PATCH, "PATCH", { reminder: on });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "reminders_need_inbound_webhook" });
    expect((await save({ reminder: on })).status).toBe(400);
    expect(cfg()).not.toHaveProperty("reminder");
  });

  it("while reminders are on, the form can't save a non-Google link", async () => {
    await save({ reminder: on });
    const res = await save({ reviewUrl: "https://example.com/review" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "reminders_google_link_only" });
    expect(cfg()).toMatchObject({ reviewUrl: REVIEW_URL, reminder: on });
  });

  it("switching reminders OFF needs none of this", async () => {
    mem.seed(`subAccounts/${SA}`, {
      ...mem.read(`subAccounts/${SA}`)!,
      googleReviewConfig: { reviewUrl: "https://example.com/r", channel: "whatsapp_manual", reminder: on },
    });
    delete process.env.AUTOMATIONS_TOKEN_SECRET;
    expect((await call(PATCH, "PATCH", { reminder: { everyDays: null, maxRetries: 2 } })).status).toBe(200);
    expect(cfg()?.reminder).toEqual({ everyDays: null, maxRetries: 2 });
  });
});

describe("PATCH (reminders only)", () => {
  it("writes only the reminder and updatedAt — a change landing between its read and write survives", async () => {
    await save({ cooldownDays: 1 });
    // Every read of the sub-account is followed by someone else's change, so a
    // write-back of the config it read would undo the latest one.
    let changes = 0;
    const realDoc = storeDb.doc;
    vi.spyOn(storeDb, "doc").mockImplementation((path: string) => {
      const ref = realDoc(path);
      if (path !== `subAccounts/${SA}`) return ref;
      const get = ref.get;
      return Object.assign(ref, {
        get: async () => {
          const snap = await get();
          changes++;
          mem.seed(path, { ...mem.read(path)!, googleReviewConfig: { ...cfg(), cooldownDays: 100 + changes } });
          return snap;
        },
      });
    });
    expect((await call(PATCH, "PATCH", { reminder: { everyDays: 2, maxRetries: 1 } })).status).toBe(200);
    vi.mocked(storeDb.doc).mockRestore();
    expect(cfg()).toMatchObject({ cooldownDays: 100 + changes, reminder: { everyDays: 2, maxRetries: 1 } });
  });

  it("changes only the reminder and nothing else", async () => {
    await save({ messageTemplate: "Hi {{firstName}}: {{reviewUrl}}", cooldownDays: 30 });
    const before = cfg()!;
    const res = await call(PATCH, "PATCH", { reminder: { everyDays: 7, maxRetries: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reminder: { everyDays: 7, maxRetries: 1 } });
    const { reminder, updatedAt: _u, ...rest } = cfg()!;
    const { updatedAt: _b, ...restBefore } = before;
    expect(reminder).toEqual({ everyDays: 7, maxRetries: 1 });
    expect(rest).toEqual(restBefore);
  });

  it("needs a saved review link first", async () => {
    const res = await call(PATCH, "PATCH", { reminder: { everyDays: 7, maxRetries: 1 } });
    expect(res.status).toBe(400);
    expect(cfg()).toBeUndefined();
  });

  it("validates like POST", async () => {
    await save();
    expect((await call(PATCH, "PATCH", { reminder: { everyDays: 8, maxRetries: 1 } })).status).toBe(400);
    expect(cfg()).not.toHaveProperty("reminder");
  });

  it("a collaborator cannot change reminders", async () => {
    await save();
    expect((await call(PATCH, "PATCH", { reminder: { everyDays: 7, maxRetries: 1 } }, "uid_collab")).status).toBe(403);
    expect(cfg()).not.toHaveProperty("reminder");
  });
});
