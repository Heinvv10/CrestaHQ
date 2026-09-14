import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/cron/review-reminder (SP5 d2). The QStash signature is verified
 * for REAL (Upstash's Receiver, test keys) and minted exactly as QStash does
 * (e2e/lib/qstash.ts), bound to this route's URL. The worker behind it is
 * tested in lib/reviews/reminder-run.test.ts; here only the door.
 */

const run = vi.fn();
vi.mock("@/lib/reviews/reminder-run", () => ({ runReviewReminder: (...a: unknown[]) => run(...a) }));

const KEY = "sig_test_current_key_for_review_reminder";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_review_reminder";

import { signQStashBody } from "../../../../../e2e/lib/qstash";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const URL_ = "http://127.0.0.1:3100/api/cron/review-reminder";
const GOOD = JSON.stringify({ subAccountId: "sa1", requestId: "req1", attempt: 1 });

function cron(body = GOOD, signature: string | null = signQStashBody(URL_, body)) {
  const headers: Record<string, string> = signature ? { "upstash-signature": signature } : {};
  return POST(new Request(URL_, { method: "POST", headers, body }));
}

beforeEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  run.mockReset().mockResolvedValue({ outcome: "sent" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("the signed door", () => {
  it("runs the reminder for a correctly signed body", async () => {
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "sent" });
    expect(run).toHaveBeenCalledWith({ subAccountId: "sa1", requestId: "req1", attempt: 1 });
  });

  it.each([
    ["no signature", () => cron(GOOD, null)],
    ["a signature for another body", () => cron(GOOD, signQStashBody(URL_, "{}"))],
    ["a signature minted for another route", () => cron(GOOD, signQStashBody("http://127.0.0.1:3100/api/cron/gbp-sync", GOOD))],
  ])("refuses %s", async (_l, go) => {
    expect((await go()).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "nope"],
    ["an id with a slash", JSON.stringify({ subAccountId: "sa1/x", requestId: "req1", attempt: 1 })],
    ["attempt 0", JSON.stringify({ subAccountId: "sa1", requestId: "req1", attempt: 0 })],
    ["attempt not an integer", JSON.stringify({ subAccountId: "sa1", requestId: "req1", attempt: "1" })],
  ])("400s a signed but malformed body (%s) without retry value", async (_l, body) => {
    expect((await cron(body)).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("500s when the worker throws, so QStash retries (the claim makes a retry safe)", async () => {
    run.mockRejectedValueOnce(new Error("firestore unavailable"));
    expect((await cron()).status).toBe(500);
  });
});
