import { expect, it, vi } from "vitest";

/**
 * The spam guard's per-IP limit must key on the one trusted client-IP helper,
 * not on the left-most X-Forwarded-For entry, which the caller writes and
 * could vary per request for a fresh budget each time.
 */

const spamIps: Array<string | null> = [];
vi.mock("@/lib/forms/spam-guard", () => ({
  checkFormSpam: (input: { ip: string | null }) => {
    spamIps.push(input.ip);
    return { kind: "rate_limited", retryAfterSec: 1 };
  },
  ELAPSED_BODY_KEY: "_elapsed",
  HONEYPOT_BODY_KEY: "_hp",
}));
vi.mock("@/lib/checkout/rate-limit", () => ({ clientIpFrom: () => "trusted-ip" }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: async () => undefined }));

const { POST } = await import("./route");

it("rate-limits on the trusted client IP, not the caller-supplied X-Forwarded-For", async () => {
  const res = await POST(
    new Request("http://x/api/forms/f1/submit", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ values: { name: "Thandi" } }),
    }),
    { params: Promise.resolve({ id: "f1" }) },
  );
  expect(res.status).toBe(429);
  expect(spamIps).toEqual(["trusted-ip"]);
});
