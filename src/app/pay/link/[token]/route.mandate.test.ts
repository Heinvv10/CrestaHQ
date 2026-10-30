import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_KEY,
  mem,
  seedInvoice,
  seedLink,
  seedSchedule,
  seedSub,
  stubPaystack,
  type PaystackCall,
} from "@/test/paystack-links-harness";

/**
 * The card-on-file pay page: the recurring terms are shown above the button,
 * exactly the wording that is then recorded as consent, with the time and
 * the payer's IP, on the checkout attempt.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";
process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.com";

const { GET, POST } = await import("./route");
const { issuePaymentLinkToken } = await import("@/lib/billing/token");

const TERMS = {
  amountCents: 115000,
  currency: "ZAR",
  frequency: "every month",
  text: "By paying, you authorise Acme <Ltd> to charge this card R 1,150.00 every month.",
};

let calls: PaystackCall[];
let token: string;
let ip = 0;

const get = () =>
  GET(new Request(`https://crm.example.com/pay/link/${token}`), { params: Promise.resolve({ token }) });

function post(fields: Record<string, string>) {
  return POST(
    new Request(`https://crm.example.com/pay/link/${token}`, {
      method: "POST",
      // Right-most hop = the address our proxy appended (see clientIpFrom).
      headers: { "x-forwarded-for": `172.16.0.1, 10.0.1.${++ip}` },
      body: new URLSearchParams(fields),
    }),
    { params: Promise.resolve({ token }) },
  );
}

const attempts = () => mem.list("paymentAttempts");

beforeEach(() => {
  mem.clear();
  seedSub();
  seedInvoice("inv1", { recurringInvoiceId: "rec1" });
  seedSchedule();
  token = issuePaymentLinkToken("link1");
  seedLink("link1", {
    token,
    invoiceId: "inv1",
    contactId: "c1",
    amountCents: 115000,
    recurringInvoiceId: "rec1",
    mandate: TERMS,
  });
  calls = stubPaystack(() => ({
    body: { status: true, data: { authorization_url: "https://checkout.paystack.com/abc", reference: "r" } },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET", () => {
  it("shows the recurring terms above the pay button", async () => {
    const html = await (await get()).text();
    const escaped = "By paying, you authorise Acme &#60;Ltd&#62; to charge this card R 1,150.00 every month.";
    const terms = html.indexOf(escaped);
    expect(terms).toBeGreaterThan(-1);
    expect(terms).toBeLessThan(html.indexOf("<button"));
    expect(html).not.toContain("<Ltd>");
  });

  it("an ordinary link shows no terms", async () => {
    seedLink("link1", { token, invoiceId: "inv1", amountCents: 115000, mandate: null, recurringInvoiceId: null });
    expect(await (await get()).text()).not.toContain("authorise");
  });

  it("refuses when the schedule's amount changed since the link was made", async () => {
    seedSchedule("rec1", { globalTaxPercent: null });
    expect((await get()).status).toBe(410);
  });

  it("refuses when the schedule's frequency changed since the link was made", async () => {
    seedSchedule("rec1", { cadence: { unit: "week", interval: 1 } });
    expect((await get()).status).toBe(410);
  });

  it("refuses when the schedule is no longer active", async () => {
    seedSchedule("rec1", { status: "cancelled" });
    expect((await get()).status).toBe(410);
  });

  it("refuses when the schedule is gone or belongs to another sub-account", async () => {
    seedSchedule("rec1", { subAccountId: "sa2" });
    expect((await get()).status).toBe(410);
    mem.clear();
    seedSub();
    seedInvoice("inv1", { recurringInvoiceId: "rec1" });
    seedLink("link1", { token, invoiceId: "inv1", amountCents: 115000, recurringInvoiceId: "rec1", mandate: TERMS });
    expect((await get()).status).toBe(410);
  });
});

describe("POST", () => {
  it("records the exact terms, the time and the payer's IP as consent on the attempt", async () => {
    const before = Date.now();
    expect((await post({ email: "payer@example.com" })).status).toBe(303);
    const [attempt] = attempts();
    expect(attempt.consent).toMatchObject({ text: TERMS.text, ip: `10.0.1.${ip}` });
    const at = (attempt.consent as { acceptedAt: Date }).acceptedAt;
    expect(at).toBeInstanceOf(Date);
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("opens a card-only checkout, since only a card can be charged again", async () => {
    await post({ email: "payer@example.com" });
    expect(calls[0].body).toMatchObject({ amount: 115000, channels: ["card"] });
  });

  it("an ordinary link records no consent and does not restrict channels", async () => {
    seedLink("link1", { token, invoiceId: "inv1", amountCents: 115000, mandate: null, recurringInvoiceId: null });
    await post({ email: "payer@example.com" });
    expect(attempts()[0].consent ?? null).toBeNull();
    expect(calls[0].body).not.toHaveProperty("channels");
  });

  it("the mode guard holds for card-on-file links too", async () => {
    seedSub(undefined, LIVE_KEY);
    expect((await post({ email: "payer@example.com" })).status).toBe(410);
    expect(calls).toEqual([]);
    expect(attempts()).toEqual([]);
  });

  it("refuses when the schedule changed, without opening a checkout", async () => {
    seedSchedule("rec1", { status: "paused" });
    expect((await post({ email: "payer@example.com" })).status).toBe(410);
    expect(calls).toEqual([]);
  });
});
