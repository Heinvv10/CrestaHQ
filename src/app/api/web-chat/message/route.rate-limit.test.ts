import { expect, it, vi } from "vitest";

/**
 * The per-IP limit must key on the one trusted client-IP helper, not on the
 * left-most X-Forwarded-For entry, which the caller writes and could vary per
 * request for a fresh budget each time.
 */

const limitedIps: string[] = [];
vi.mock("@/lib/comms/web-chat/rate-limit", () => ({
  checkAndCount: (ip: string) => {
    limitedIps.push(ip);
    return { ok: false, reason: "ip", retryAfterSec: 1 };
  },
}));
vi.mock("@/lib/checkout/rate-limit", () => ({ clientIpFrom: () => "trusted-ip" }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
vi.mock("@/lib/comms/ai/agent", () => ({
  getChannelConfig: async () => ({ enabled: true, webChat: {} }),
}));
vi.mock("@/lib/comms/ai/gates", () => ({ aiChannelGateOn: () => true }));
vi.mock("@/lib/comms/web-chat/respond", () => ({
  respondToWebChat: async () => {
    throw new Error("not expected — the request is rate-limited");
  },
}));

const { POST } = await import("./route");

it("rate-limits on the trusted client IP, not the caller-supplied X-Forwarded-For", async () => {
  const res = await POST(
    new Request("https://app.test/api/web-chat/message", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ sa: "sa1", sessionId: "sess_0123456789abcdef", message: "hi" }),
    }),
  );
  expect(res.status).toBe(429);
  expect(limitedIps).toEqual(["trusted-ip"]);
});
