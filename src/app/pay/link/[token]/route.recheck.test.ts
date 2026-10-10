import { beforeEach, describe, expect, it, vi } from "vitest";

import { mem, seedLink, seedSub } from "@/test/paystack-links-harness";

/**
 * Paystack redirects the payer before its webhook lands, so the "confirming"
 * page reloads itself until the webhook has recorded the reference — and
 * never more than CONFIRM_RECHECKS times, whatever the URL claims.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";

const { GET } = await import("./route");
const { issuePaymentLinkToken } = await import("@/lib/billing/token");

const REF = "pl-link1-0123456789abcdef";
let token: string;

beforeEach(() => {
  mem.clear();
  seedSub();
  token = issuePaymentLinkToken("link1");
  seedLink("link1", { token });
});

async function html(query: string): Promise<string> {
  const res = await GET(new Request(`https://crm.example.com/pay/link/${token}${query}`), {
    params: Promise.resolve({ token }),
  });
  return res.text();
}

const refreshTo = (h: string) => /<meta http-equiv="refresh" content="3;url=\?([^"]*)">/.exec(h)?.[1] ?? null;

describe("the confirming page re-checking for a late webhook", () => {
  it("reloads the same reference with the count bumped", async () => {
    expect(refreshTo(await html(`?trxref=${REF}&reference=${REF}`))).toBe(
      `trxref=${REF}&#38;reference=${REF}&#38;recheck=1`,
    );
  });

  it("takes its last reload at 19", async () => {
    expect(refreshTo(await html(`?reference=${REF}&recheck=19`))).toBe(`reference=${REF}&#38;recheck=20`);
  });

  it("stops at the cap and tells the payer it is taking longer", async () => {
    const h = await html(`?reference=${REF}&recheck=20`);
    expect(h).toContain("Confirming your payment");
    expect(h).toContain("taking longer than usual");
    expect(h).not.toContain("http-equiv");
  });

  it.each(["-1000000", "-Infinity", "Infinity", "1e400", "abc", "", "0.5"])(
    "restarts the count at 0 for recheck=%s, so a crafted value cannot lift the cap",
    async (value) => {
      expect(refreshTo(await html(`?reference=${REF}&recheck=${encodeURIComponent(value)}`))).toBe(
        `reference=${REF}&#38;recheck=1`,
      );
    },
  );

  it("cannot break out of the refresh attribute", async () => {
    const h = await html(`?reference=${REF}&x=${encodeURIComponent(`"><script>alert(1)</script>`)}`);
    expect(h).not.toContain("<script>");
    expect(refreshTo(h)).toMatch(/^reference=.*&#38;x=%22%3E%3Cscript%3E.*&#38;recheck=1$/);
  });

  it("does not reload a page that already says the payment was received", async () => {
    seedLink("link1", { token, status: "paid", paystackReference: REF });
    const h = await html(`?reference=${REF}`);
    expect(h).toContain("Payment received");
    expect(h).not.toContain("http-equiv");
  });
});
