import { beforeEach, describe, expect, it, vi } from "vitest";

import { mem, seedLink, seedSub } from "@/test/paystack-links-harness";

/**
 * The `?reference=` on a returning payer's URL is untrusted and is used to
 * name a `paymentAttempts/{reference}` doc. Anything that is not this link's
 * own `pl-{linkId}-{16 hex}` must be refused BEFORE it reaches that lookup,
 * so it can never name another path.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
const loadPaymentAttempt = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/payment-attempts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/payment-attempts")>();
  loadPaymentAttempt.mockImplementation(real.loadPaymentAttempt);
  return { ...real, loadPaymentAttempt };
});
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";

const { GET } = await import("./route");
const { issuePaymentLinkToken } = await import("@/lib/billing/token");

let token: string;

beforeEach(() => {
  mem.clear();
  seedSub();
  token = issuePaymentLinkToken("link1");
  seedLink("link1", { token, active: false });
  loadPaymentAttempt.mockClear();
});

describe("a returning payer's reference on a withdrawn link", () => {
  it.each([
    ["a path", "a/b"],
    ["this link's prefix with an extra segment", "pl-link1-0123456789abcdef/x"],
  ])("refuses %s without looking it up", async (_label, reference) => {
    const res = await GET(
      new Request(`https://crm.example.com/pay/link/${token}?reference=${encodeURIComponent(reference)}`),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(410);
    expect(loadPaymentAttempt).not.toHaveBeenCalled();
  });
});
