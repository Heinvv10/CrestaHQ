import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  gate: "deliver" as string,
  gateCalls: [] as string[],
  delivered: [] as string[],
  deliverError: null as Error | null,
  afterTasks: [] as Array<() => Promise<void>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => m.afterTasks.push(task),
}));
vi.mock("@/lib/auth/password-reset", () => ({
  gatePasswordReset: (email: string) => {
    m.gateCalls.push(email);
    return m.gate;
  },
  deliverPasswordReset: async (email: string) => {
    if (m.deliverError) throw m.deliverError;
    m.delivered.push(email);
    return "sent";
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

beforeEach(() => {
  m.gate = "deliver";
  m.gateCalls.length = 0;
  m.delivered.length = 0;
  m.deliverError = null;
  m.afterTasks.length = 0;
});

describe("POST /api/auth/password-reset", () => {
  it("answers before delivering, and delivers after the response", async () => {
    const res = await post({ email: "a@x.test" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.delivered).toEqual([]);
    expect(m.afterTasks).toHaveLength(1);
    await m.afterTasks[0]!();
    expect(m.delivered).toEqual(["a@x.test"]);
  });

  it("logs a failed delivery instead of throwing out of after()", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.deliverError = new Error("smtp down");
    await post({ email: "a@x.test" });
    await expect(m.afterTasks[0]!()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("[password-reset] send failed", "smtp down");
    spy.mockRestore();
  });

  it("tells the client to fall back, and schedules nothing", async () => {
    m.gate = "fallback";
    expect(await (await post({ email: "a@x.test" })).json()).toEqual({ fallback: true });
    expect(m.afterTasks).toHaveLength(0);
  });

  it("answers a capped address like any other, and schedules nothing", async () => {
    m.gate = "quiet";
    const res = await post({ email: "a@x.test" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.afterTasks).toHaveLength(0);
  });

  it("returns 429 when rate-limited, and schedules nothing", async () => {
    m.gate = "limited";
    expect((await post({ email: "a@x.test" })).status).toBe(429);
    expect(m.afterTasks).toHaveLength(0);
  });

  it("normalises the address and rejects junk before the gate", async () => {
    await post({ email: "  Mixed@X.Test " });
    expect(m.gateCalls).toEqual(["mixed@x.test"]);
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(m.gateCalls).toHaveLength(1);
  });
});
