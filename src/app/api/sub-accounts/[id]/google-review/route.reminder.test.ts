import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP5 d2 — the reminder setting on the google-review config route, over REAL
 * require-tenancy and the in-memory Firestore. Off by default; a save that
 * does not mention reminders never changes them; only an admin may change
 * them; out-of-range values are refused.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { PATCH, POST } from "./route";

const REVIEW_URL = "https://g.page/r/fixture/review";
const cfg = () => mem.read(`subAccounts/${SA}`)?.googleReviewConfig as Record<string, unknown> | null | undefined;

function call(handler: typeof POST, method: string, body: Record<string, unknown>, uid = "uid_admin") {
  return handler(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/google-review`, uid, method, JSON.stringify(body)), {
    params: Promise.resolve({ id: SA }),
  });
}
const save = (extra: Record<string, unknown> = {}) =>
  call(POST, "POST", { enabled: false, reviewUrl: REVIEW_URL, channel: "sms", ...extra });

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("POST (the whole config)", () => {
  it("a save that never mentions reminders writes no reminder key — the stored config is as before", async () => {
    expect((await save()).status).toBe(200);
    expect(cfg()).not.toHaveProperty("reminder");
  });

  it("saves reminders when given, and a later save without them keeps them", async () => {
    expect((await save({ reminder: { everyDays: 3, maxRetries: 2 } })).status).toBe(200);
    expect(cfg()?.reminder).toEqual({ everyDays: 3, maxRetries: 2 });
    expect((await save({ messageTemplate: "Hi {{firstName}}: {{reviewUrl}}" })).status).toBe(200);
    expect(cfg()?.reminder).toEqual({ everyDays: 3, maxRetries: 2 });
  });

  it("everyDays null is 'Don't repeat' (off)", async () => {
    await save({ reminder: { everyDays: null, maxRetries: 3 } });
    expect(cfg()?.reminder).toEqual({ everyDays: null, maxRetries: 3 });
  });

  it.each([
    [{ everyDays: 0, maxRetries: 2 }],
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

describe("PATCH (reminders only)", () => {
  it("changes only the reminder and nothing else", async () => {
    await save({ messageTemplate: "Hi {{firstName}}: {{reviewUrl}}", cooldownDays: 30 });
    const before = cfg()!;
    const res = await call(PATCH, "PATCH", { reminder: { everyDays: 7, maxRetries: 1 } });
    expect(res.status).toBe(200);
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
    expect((await call(PATCH, "PATCH", { reminder: { everyDays: 99, maxRetries: 1 } })).status).toBe(400);
    expect(cfg()).not.toHaveProperty("reminder");
  });

  it("a collaborator cannot change reminders", async () => {
    await save();
    expect((await call(PATCH, "PATCH", { reminder: { everyDays: 7, maxRetries: 1 } }, "uid_collab")).status).toBe(403);
    expect(cfg()).not.toHaveProperty("reminder");
  });
});
