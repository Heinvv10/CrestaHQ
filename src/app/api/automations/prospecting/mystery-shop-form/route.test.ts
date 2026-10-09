import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/automations/prospecting/mystery-shop-form — the form job's door.
 * The QStash signature is verified for REAL (minted as QStash does, bound to
 * this URL); the job itself is form/job.test.ts.
 */

const runFormJob = vi.fn();
vi.mock("@/lib/prospecting/mystery-shop/form/job", () => ({
  FORM_JOB_PATH: "/api/automations/prospecting/mystery-shop-form",
  runFormJob: (...a: unknown[]) => runFormJob(...a),
}));

const KEY = "sig_test_current_key_for_form_jobs";
const { signQStashBody } = await import("../../../../../../e2e/lib/qstash");
const { POST } = await import("./route");

const ORIGINAL = { ...process.env };
const URL_ = "http://127.0.0.1:3100/api/automations/prospecting/mystery-shop-form";
const body = (shopId = "f1") => JSON.stringify({ shopId });

function call(b = body(), signature: string | null = signQStashBody(URL_, b)) {
  const headers: Record<string, string> = signature ? { "upstash-signature": signature } : {};
  return POST(new Request(URL_, { method: "POST", headers, body: b }));
}

beforeEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_form_jobs";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  runFormJob.mockReset().mockResolvedValue("sent");
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("the door", () => {
  it("refuses an unsigned call, or one signed for another route, without running", async () => {
    expect((await call(body(), null)).status).toBe(401);
    const timer = signQStashBody("http://127.0.0.1:3100/api/automations/prospecting/mystery-shop", body());
    expect((await call(body(), timer)).status).toBe(401);
    expect((await call(body(), signQStashBody(URL_, body("other")))).status).toBe(401);
    expect(runFormJob).not.toHaveBeenCalled();
  });

  it("answers 400 for a malformed body", async () => {
    expect((await call(JSON.stringify({ shopId: "a/b" }))).status).toBe(400);
    expect((await call("{nope")).status).toBe(400);
    expect(runFormJob).not.toHaveBeenCalled();
  });
});

describe("the job", () => {
  it("runs the shop's job and reports the outcome", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "sent" });
    expect(runFormJob).toHaveBeenCalledWith("f1");
  });

  it("a busy box whose re-queue was not taken asks QStash to deliver again", async () => {
    runFormJob.mockResolvedValue("requeue_failed");
    expect((await call()).status).toBe(503);
  });

  it.each(["noop", "requeued", "engine_busy", "refused", "failed", "uncertain"])("%s is a 200 (no retry)", async (outcome) => {
    runFormJob.mockResolvedValue(outcome);
    expect((await call()).status).toBe(200);
  });
});
