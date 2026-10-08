import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The end-of-call webhook's mystery-shop hook: a mystery-shop call's report
 * goes to its shop, an inbound call is checked as a callback, an ordinary
 * outbound call is neither — and a failing hook never stops the report.
 */

let authorized = true;
vi.mock("@/lib/comms/voice/webhook-auth", () => ({ vapiWebhookAuthorized: () => authorized }));
const handle = vi.fn();
vi.mock("@/lib/comms/voice/end-of-call", () => ({ handleVapiEndOfCall: (...a: unknown[]) => handle(...a) }));
const settle = vi.fn();
const callback = vi.fn();
vi.mock("@/lib/prospecting/mystery-shop/inbound", () => ({
  settleMysteryShopCall: (...a: unknown[]) => settle(...a),
  matchInboundCallback: (...a: unknown[]) => callback(...a),
}));

const { POST } = await import("./route");

const post = (message: Record<string, unknown>) =>
  POST(
    new Request("https://app.test/api/webhooks/vapi/end-of-call/sa1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { type: "end-of-call-report", ...message } }),
    }),
    { params: Promise.resolve({ subAccountId: "sa1" }) },
  );

const REPORT = {
  endedReason: "customer-ended-call",
  durationSeconds: 30,
  startedAt: "2026-10-08T08:00:12.000Z",
  endedAt: "2026-10-08T08:00:42.000Z",
  artifact: { messages: [{ role: "bot", message: "Hi" }, { role: "user", message: "Yes we do" }] },
};

beforeEach(() => {
  authorized = true;
  handle.mockReset().mockResolvedValue({ errors: [] });
  settle.mockReset().mockResolvedValue(undefined);
  callback.mockReset().mockResolvedValue(undefined);
});

describe("mystery-shop hook", () => {
  it("a mystery-shop call settles its shop from the report", async () => {
    await post({ ...REPORT, call: { id: "call1", customer: { number: "+27821234567" }, metadata: { direction: "outbound", mysteryShopId: "s1" } } });
    expect(settle).toHaveBeenCalledWith("sa1", "s1", "call1", expect.objectContaining({
      endedReason: "customer-ended-call",
      durationSec: 30,
      startedAtMs: Date.parse(REPORT.startedAt),
      endedAtMs: Date.parse(REPORT.endedAt),
      userSpoke: true,
    }));
    expect(callback).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalled();
  });

  it("an inbound call is checked as a callback from the caller's number", async () => {
    await post({ ...REPORT, artifact: { messages: [] }, call: { id: "call2", customer: { number: "+27821234567" } } });
    expect(callback).toHaveBeenCalledWith("sa1", "+27821234567", expect.objectContaining({ userSpoke: false }));
    expect(settle).not.toHaveBeenCalled();
  });

  it("an unauthenticated webhook is refused before either hook runs", async () => {
    authorized = false;
    const res = await post({ ...REPORT, call: { id: "call5", customer: { number: "+27821234567" }, metadata: { mysteryShopId: "s1" } } });
    expect(res.status).toBe(401);
    expect(settle).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("an ordinary outbound call is neither", async () => {
    await post({ ...REPORT, call: { id: "call3", metadata: { direction: "outbound", contactId: "c1" } } });
    expect(settle).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("a failing hook is logged and the report is still handled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    settle.mockRejectedValueOnce(new Error("firestore down"));
    const res = await post({ ...REPORT, call: { id: "call4", metadata: { direction: "outbound", mysteryShopId: "s1" } } });
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalled();
  });
});
