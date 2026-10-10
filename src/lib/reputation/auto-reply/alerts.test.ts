import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Delivery of the auto-reply alerts through the WhatsApp alerts' rail: a push
 * to the sub-account (sendPushForEvent) and an email to the agency owner. The
 * store is in memory; push and email are captured; both providers are in
 * their REAL modes (fake mode delivers nothing — last test). Delivery runs in
 * the background, so each test waits for it (`flushAfterResponse`).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const mode = vi.hoisted(() => ({ fake: false }));
vi.mock("@/lib/gbp/provider/mode", async (orig) => {
  const real = await orig<typeof import("@/lib/gbp/provider/mode")>();
  return { ...real, gbpProviderMode: () => (mode.fake ? "fake" : "google") };
});
vi.mock("@/lib/reputation/ai/mode", async (orig) => {
  const real = await orig<typeof import("@/lib/reputation/ai/mode")>();
  return { ...real, reviewsAiMode: () => "openrouter" };
});
const sent = vi.hoisted(() => ({ push: [] as Record<string, unknown>[], email: [] as Record<string, unknown>[], hang: false, hung: 0, release: [] as Array<() => void> }));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: async (i: Record<string, unknown>) => void sent.push.push(i) }));
vi.mock("@/lib/push/config", () => ({ pushIsConfigured: () => true }));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  sendEmail: (i: Record<string, unknown>) =>
    sent.hang ? (sent.hung++, new Promise<void>((r) => sent.release.push(r))) : Promise.resolve(void sent.email.push(i)),
}));

import { mem } from "@/test/gbp-sync-store";
import { autoReplyAlertsCollection, sendAutoReplyAlert } from "./alerts";

const SA = "sa_1";
const OTHER = "sa_2";
const TEXT = "Line one\nof a review that runs well past the eighty character limit so the rest must never be sent anywhere at all.";

beforeEach(() => {
  mem.clear();
  sent.push.length = 0;
  sent.email.length = 0;
  mode.fake = false;
  sent.hang = false;
  sent.hung = 0;
  sent.release.length = 0;
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag_1", name: "Velo Test" });
  mem.seed(`subAccounts/${OTHER}`, { agencyId: "ag_2", name: "Other Co" });
  mem.seed("agencies/ag_1", { ownerUid: "owner_1" });
  mem.seed("agencies/ag_2", { ownerUid: "owner_2" });
  mem.seed("users/owner_1", { email: "owner1@example.test" });
  mem.seed("users/owner_2", { email: "owner2@example.test" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const reviewName = "accounts/a/locations/l/reviews/r1";
/** Grace period for the one negative assertion (nothing is delivered). */

describe("sendAutoReplyAlert", () => {
  it("edited_low: push and email carry the star and at most the first 80 characters — never more, never a name", async () => {
    await sendAutoReplyAlert(SA, { kind: "edited_low", reviewName, reviewDocId: "d1", star: 2, comment: TEXT });
    await flushAfterResponse();
    expect(sent.push).toHaveLength(1);
    expect(sent.email).toHaveLength(1);
    const excerpt = "Line one of a review that runs well past the eighty character limit so the rest";
    // Characters 1–80 (newline collapsed) end in a space, trimmed: 79 left.
    expect(Array.from(excerpt)).toHaveLength(79);
    const push = sent.push[0];
    expect(push).toMatchObject({ subAccountId: SA, agencyId: "ag_1", url: `/sa/${SA}/reputation/reviews` });
    expect(String(push.title)).toContain("2★");
    expect(String(push.body)).toContain(excerpt);
    for (const out of [JSON.stringify(push), JSON.stringify(sent.email[0])]) {
      expect(out).not.toContain("must never be sent");
    }
    expect(sent.email[0]).toMatchObject({ to: "owner1@example.test", archive: false });
    expect(String(sent.email[0].subject)).not.toContain("Line one");
  });

  it("goes to the alert's own tenant: agency, members and owner of THAT sub-account", async () => {
    await sendAutoReplyAlert(OTHER, { kind: "listing_changed" });
    await flushAfterResponse();
    expect(sent.push).toHaveLength(1);
    expect(sent.email).toHaveLength(1);
    expect(sent.push[0]).toMatchObject({ subAccountId: OTHER, agencyId: "ag_2" });
    expect(sent.email[0]).toMatchObject({ to: "owner2@example.test" });
    expect(mem.list(autoReplyAlertsCollection(OTHER))).toHaveLength(1);
    expect(mem.list(autoReplyAlertsCollection(SA))).toEqual([]);
  });

  it("the same held run or edited review twice → one doc, one push, one email", async () => {
    await sendAutoReplyAlert(SA, { kind: "held", runId: "run-1", count: 2 });
    await sendAutoReplyAlert(SA, { kind: "held", runId: "run-1", count: 2 });
    await sendAutoReplyAlert(SA, { kind: "edited_low", reviewName, reviewDocId: "d1", star: 2, comment: null });
    await sendAutoReplyAlert(SA, { kind: "edited_low", reviewName, reviewDocId: "d1", star: 1, comment: null });
    await flushAfterResponse();
    expect(sent.push).toHaveLength(2);
    expect(sent.email).toHaveLength(2);
    expect(mem.list(autoReplyAlertsCollection(SA))).toHaveLength(2);
  });

  it("reconnect_required and held: no review content at all", async () => {
    await sendAutoReplyAlert(SA, { kind: "reconnect_required" });
    await sendAutoReplyAlert(SA, { kind: "held", runId: "run-2", count: 3 });
    await flushAfterResponse();
    expect(sent.push).toHaveLength(2);
    expect(sent.email).toHaveLength(2);
    expect(String(sent.push[1].body)).toContain("3 Google reviews");
    expect(sent.push.map((p) => p.url)).toEqual([`/sa/${SA}/reputation`, `/sa/${SA}/reputation/reviews`]);
  });

  it("two different edited reviews: separate push tags, so neither replaces the other on a device", async () => {
    await sendAutoReplyAlert(SA, { kind: "edited_low", reviewName, reviewDocId: "d1", star: 2, comment: null });
    await sendAutoReplyAlert(SA, { kind: "edited_low", reviewName: `${reviewName}x`, reviewDocId: "d2", star: 1, comment: null });
    await flushAfterResponse();
    expect(sent.push).toHaveLength(2);
    expect(sent.email).toHaveLength(2);
    expect(new Set(sent.push.map((p) => p.tag)).size).toBe(2);
  });

  it("a hanging email does not hold the caller: sendAutoReplyAlert returns once the doc exists", async () => {
    sent.hang = true;
    const done = await Promise.race([
      sendAutoReplyAlert(SA, { kind: "listing_changed" }).then(() => "returned"),
      new Promise((r) => setTimeout(() => r("blocked"), 200)),
    ]);
    expect(done).toBe("returned");
    expect(mem.list(autoReplyAlertsCollection(SA))).toHaveLength(1);
    // the email reaches its (hanging) send before the next test resets the flag
    await vi.waitFor(() => expect(sent.hung).toBe(1));
    // Let the held send finish: a task that never settles would hang every later flush.
    for (const r of sent.release) r();
    await flushAfterResponse();
    });

  it("fake mode: the doc is written, nothing is delivered", async () => {
    mode.fake = true;
    await sendAutoReplyAlert(SA, { kind: "listing_changed" });
    await flushAfterResponse();
    expect(mem.list(autoReplyAlertsCollection(SA))).toHaveLength(1);
    expect(sent.push).toEqual([]);
    expect(sent.email).toEqual([]);
  });
});
