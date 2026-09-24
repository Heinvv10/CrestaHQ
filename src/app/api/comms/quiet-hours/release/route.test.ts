import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/comms/quiet-hours/release. The QStash signature is verified for
 * REAL and minted as QStash does, bound to this route's URL. The worker is
 * tested in lib/comms/quiet-hours-release.test.ts; here only the door.
 */

const release = vi.fn();
vi.mock("@/lib/comms/quiet-hours-release", () => ({
  releaseQuietHoursHold: (...a: unknown[]) => release(...a),
}));

const KEY = "sig_test_current_key_for_quiet_hours";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_quiet_hours";

import { signQStashBody } from "../../../../../../e2e/lib/qstash";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const URL_ = "http://127.0.0.1:3100/api/comms/quiet-hours/release";
const GOOD = JSON.stringify({ subAccountId: "sa1", holdId: "h1" });

function call(body = GOOD, signature: string | null = signQStashBody(URL_, body)) {
  const headers: Record<string, string> = signature ? { "upstash-signature": signature } : {};
  return POST(new Request(URL_, { method: "POST", headers, body }));
}

beforeEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  release.mockReset().mockResolvedValue({ outcome: "released" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("the quiet-hours release door", () => {
  it("releases the hold for a correctly signed body", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(release).toHaveBeenCalledWith("sa1", "h1");
  });

  it("refuses an unsigned call, or one signed for another route, without releasing", async () => {
    expect((await call(GOOD, null)).status).toBe(401);
    const other = signQStashBody("http://127.0.0.1:3100/api/cron/review-reminder", GOOD);
    expect((await call(GOOD, other)).status).toBe(401);
    expect(release).not.toHaveBeenCalled();
  });

  it("answers 400 for a malformed body and 500 (so QStash retries) when the worker throws", async () => {
    const bad = JSON.stringify({ subAccountId: "sa/1", holdId: "h1" });
    expect((await call(bad)).status).toBe(400);
    release.mockRejectedValueOnce(new Error("boom"));
    expect((await call()).status).toBe(500);
  });
});
