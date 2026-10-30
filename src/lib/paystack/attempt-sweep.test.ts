import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LIVE_KEY, SA, mem, seedAttempt, seedLink, seedSub, stubPaystack, verified } from "@/test/paystack-links-harness";

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

const HOUR = 60 * 60 * 1000;

/** A buy-page order's open attempt made `ageHours` ago, with Paystack answering `status` for it. */
function orderAttempt(orderStatus: string, status: string, ageHours = 1) {
  const ref = "po-ord1";
  mem.seed("orders/ord1", { subAccountId: SA, source: "product_link", status: orderStatus });
  seedAttempt(ref, {
    secretKey: LIVE_KEY,
    paymentLinkId: "",
    orderId: "ord1",
    createdAt: new Date(Date.now() - ageHours * HOUR),
  });
  stubPaystack(() => verified({ reference: ref, status }));
  return ref;
}

it("a buy-page order pending and under 24 h old stays open when Paystack says abandoned: the checkout can be resumed", async () => {
  const ref = orderAttempt("pending", "abandoned", 23);
  await sweepAttempts(SA, LIVE_KEY, [ref]);
  expect(mem.read(`paymentAttempts/${ref}`)).toMatchObject({ state: "open" });
  expect(mem.read("orders/ord1")).toMatchObject({ status: "pending" });
});

it("a buy-page order pending but over 24 h old is closed with its attempt when Paystack says abandoned", async () => {
  const ref = orderAttempt("pending", "abandoned", 25);
  await sweepAttempts(SA, LIVE_KEY, [ref]);
  expect(mem.read(`paymentAttempts/${ref}`)).toMatchObject({ state: "refused" });
  expect(mem.read("orders/ord1")).toMatchObject({ status: "expired" });
});

it("a buy-page order that failed is closed as refused when Paystack says abandoned", async () => {
  const ref = orderAttempt("failed", "abandoned");
  await sweepAttempts(SA, LIVE_KEY, [ref]);
  expect(mem.read(`paymentAttempts/${ref}`)).toMatchObject({ state: "refused" });
  expect(mem.read("orders/ord1")).toMatchObject({ status: "failed" });
});

it("a reversed buy-page payment closes the attempt and expires the young pending order", async () => {
  const ref = orderAttempt("pending", "reversed", 1);
  await sweepAttempts(SA, LIVE_KEY, [ref]);
  expect(mem.read(`paymentAttempts/${ref}`)).toMatchObject({ state: "refused" });
  expect(mem.read("orders/ord1")).toMatchObject({ status: "expired" });
});
