import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/scheduled-messages/fire — the QStash signature is verified for
 * REAL (Upstash's Receiver with test keys, minted exactly as QStash does) and
 * bound to this route's URL, so a genuine signature for another callback is
 * refused. The worker body itself is stubbed.
 */

const m = vi.hoisted(() => ({ fire: vi.fn() }));
vi.mock("@/lib/server/scheduled-messages/fire", () => ({ fireScheduledMessage: m.fire }));
vi.mock("@/lib/server/scheduled-messages/service", () => ({
  FIRE_PATH: "/api/scheduled-messages/fire",
}));

const ORIGINAL = { ...process.env };
const APP = "http://127.0.0.1:3100";
const URL_ = `${APP}/api/scheduled-messages/fire`;
process.env.QSTASH_CURRENT_SIGNING_KEY = "sig_test_current_key_for_scheduled";
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_scheduled";
process.env.QSTASH_TOKEN = "test-token";

const { signQStashBody } = await import("../../../../../e2e/lib/qstash");
const { POST } = await import("./route");

const BODY = JSON.stringify({ contactId: "c1", scheduledMessageId: "s1" });
const call = (signature: string | null, body = BODY) =>
  POST(
    new Request(URL_, {
      method: "POST",
      headers: signature === null ? {} : { "upstash-signature": signature },
      body,
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = APP;
  m.fire.mockResolvedValue({ outcome: "sent", messageId: "SM1" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  process.env.QSTASH_CURRENT_SIGNING_KEY = "sig_test_current_key_for_scheduled";
  process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_scheduled";
  process.env.QSTASH_TOKEN = "test-token";
});

describe("POST /api/scheduled-messages/fire — signature", () => {
  it("fires on a genuine signature minted for THIS route", async () => {
    const res = await call(signQStashBody(URL_, BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "sent", messageId: "SM1" });
    expect(m.fire).toHaveBeenCalledWith("c1", "s1");
  });

  it("401s a genuine signature minted for ANOTHER callback (replay)", async () => {
    const other = signQStashBody(`${APP}/api/workflows/step`, BODY);
    expect((await call(other)).status).toBe(401);
    expect(m.fire).not.toHaveBeenCalled();
  });

  it("401s an unsigned call and a signature over a different body", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call(signQStashBody(URL_, "{}"))).status).toBe(401);
    expect(m.fire).not.toHaveBeenCalled();
  });

  it("400s a signed body without the ids", async () => {
    const body = JSON.stringify({ contactId: "c1" });
    expect((await call(signQStashBody(URL_, body), body)).status).toBe(400);
    expect(m.fire).not.toHaveBeenCalled();
  });
});
