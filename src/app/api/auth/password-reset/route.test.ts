import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ outcome: "sent" as string, calls: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/password-reset", () => ({
  requestPasswordReset: async (email: string) => {
    m.calls.push(email);
    if (m.outcome === "throw") throw new Error("smtp down");
    return m.outcome;
  },
}));

import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new Request("https://crm.test/api/auth/password-reset", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/auth/password-reset", () => {
  it("answers a sent mail and an unknown account identically", async () => {
    m.outcome = "sent";
    const sent = await post({ email: "a@x.test" });
    m.outcome = "skipped";
    const skipped = await post({ email: "b@x.test" });
    expect(sent.status).toBe(200);
    expect(skipped.status).toBe(200);
    expect(await sent.json()).toEqual(await skipped.json());
  });

  it("tells the client to fall back when the deployment has no mailbox", async () => {
    m.outcome = "fallback";
    const res = await post({ email: "a@x.test" });
    expect(await res.json()).toEqual({ fallback: true });
  });

  it("returns 429 when rate-limited", async () => {
    m.outcome = "limited";
    expect((await post({ email: "a@x.test" })).status).toBe(429);
  });

  it("returns 502 without detail when the send fails", async () => {
    m.outcome = "throw";
    const res = await post({ email: "a@x.test" });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("smtp down");
  });

  it("normalises the address and rejects junk before any work", async () => {
    m.outcome = "sent";
    m.calls.length = 0;
    await post({ email: "  Mixed@X.Test " });
    expect(m.calls).toEqual(["mixed@x.test"]);
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(m.calls).toHaveLength(1);
  });
});
