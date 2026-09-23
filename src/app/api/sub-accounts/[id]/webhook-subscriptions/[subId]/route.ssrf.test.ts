import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * PATCH must apply the same destination rules as create. Before this, it
 * only checked the scheme, so any URL rejected at create time could be set
 * by editing an existing subscription.
 */

const patches: Array<Record<string, unknown>> = [];
const dnsAnswers = new Map<string, string>();

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    const address = dnsAnswers.get(host);
    if (!address) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return [{ address, family: 4 }];
  }),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u1" }),
}));
vi.mock("@/lib/firestore/webhook-subscriptions", () => ({
  getSubscription: async () => ({ id: "s1", subAccountId: "sa1", url: "https://old.example.com/" }),
  updateSubscription: async (_sa: string, _s: string, patch: Record<string, unknown>) => {
    patches.push(patch);
  },
  deleteSubscription: async () => undefined,
  subscriptionToResponse: (d: unknown) => d,
}));

import { PATCH } from "@/app/api/sub-accounts/[id]/webhook-subscriptions/[subId]/route";

function patch(url: string) {
  return PATCH(
    new Request("https://app.test/x", { method: "PATCH", body: JSON.stringify({ url }) }),
    { params: Promise.resolve({ id: "sa1", subId: "s1" }) },
  );
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  patches.length = 0;
  dnsAnswers.clear();
});
afterEach(() => vi.unstubAllEnvs());

describe("PATCH webhook subscription url — SSRF guard", () => {
  it.each([
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://100.96.203.105:4300/x",
    "http://hooks.example.com/x", // https required in production, as on create
  ])("rejects %s and stores nothing", async (url) => {
    const res = (await patch(url)) as NextResponse;
    expect(res.status).toBe(400);
    expect(patches).toEqual([]);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    dnsAnswers.set("sneaky.example.com", "10.0.0.5");
    const res = (await patch("https://sneaky.example.com/x")) as NextResponse;
    expect(res.status).toBe(400);
    expect(patches).toEqual([]);
  });

  it("accepts a public URL", async () => {
    dnsAnswers.set("hooks.example.com", "93.184.216.34");
    const res = (await patch("https://hooks.example.com/x")) as NextResponse;
    expect(res.status).toBe(200);
    expect(patches).toEqual([{ url: "https://hooks.example.com/x" }]);
  });
});
