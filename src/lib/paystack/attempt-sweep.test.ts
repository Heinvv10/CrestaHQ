import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LIVE_KEY, SA, mem, seedAttempt, seedLink, seedSub } from "@/test/paystack-links-harness";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());

const { sweepAttempts } = await import("./attempt-sweep");

beforeEach(() => {
  mem.clear();
  seedSub(SA, LIVE_KEY);
  seedLink();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("gives up on a Paystack call that never answers, and leaves the attempt open for the flag", async () => {
  const ref = "pl-link1-0123456789abcdef";
  seedAttempt(ref, { secretKey: LIVE_KEY });
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  await sweepAttempts(SA, LIVE_KEY, [ref], { timeoutMs: 20 });
  expect(mem.read(`paymentAttempts/${ref}`)).toMatchObject({ state: "open" });
});
