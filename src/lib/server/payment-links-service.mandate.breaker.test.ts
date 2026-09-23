import { beforeEach, describe, expect, it, vi } from "vitest";

import { SA, mem, seedInvoice, seedSchedule, seedSub } from "@/test/paystack-links-harness";

/** Adversarial-review repros (round 1): the terms' currency is the charge's. */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";

const { createPaymentLink, loadPayableLink } = await import("./payment-links-service");

const create = () => createPaymentLink({ subAccountId: SA, uid: "u1", invoiceId: "inv1", mandate: true });

beforeEach(() => {
  mem.clear();
  seedSub();
  seedInvoice("inv1", { recurringInvoiceId: "rec1" });
  seedSchedule();
});

describe("breaker: terms currency", () => {
  it("B7 a USD schedule's ZAR invoice → refused (terms would promise USD, Paystack charges ZAR)", async () => {
    seedSchedule("rec1", { currency: "USD" });
    const res = await create();
    expect(res).toMatchObject({ ok: false, status: 409 });
  });

  it("B8 schedule's currency changed after the link → the pay page refuses it", async () => {
    const res = await create();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    seedSchedule("rec1", { currency: "USD" });
    expect(await loadPayableLink(res.link.token)).toMatchObject({ ok: false, status: 410 });
  });
});
