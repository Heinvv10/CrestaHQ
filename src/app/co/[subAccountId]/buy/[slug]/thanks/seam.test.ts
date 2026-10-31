import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { flushAfterResponse } from "@/lib/server/after-response";
import { deliverTo, mem, seedConnection, SA, session } from "@/test/stripe-orders-harness";

/**
 * The whole express buy path, through the real routes: the session route
 * snapshots the product's delivery onto the order it writes; Stripe's
 * webhook pays it; the thanks page (with the token from the success URL)
 * shows the download from that snapshot — not from the product, which the
 * operator may have changed since. Only the Stripe API and email are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/stripe-orders-harness")).adminMock());
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const sendEmail = vi.hoisted(() => vi.fn(async () => ({ id: "m1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/resend")>()),
  sendEmail,
}));
const stripe = vi.hoisted(() => ({
  getSubAccountStripe: vi.fn(async () => ({ mode: "key" })),
  createCheckoutSessionForSubAccount: vi.fn(async () => ({
    id: "cs_seam_1",
    url: "https://checkout.stripe.com/c/pay/cs_seam_1",
    livemode: false,
  })),
}));
vi.mock("@/lib/stripe/sub-account-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/sub-account-client")>()),
  ...stripe,
}));

const { POST: sessionPOST } = await import("@/app/api/co/[subAccountId]/buy/[slug]/session/route");
const deliver = deliverTo((await import("@/app/api/webhooks/stripe/sa/[subAccountId]/route")).POST);
const { default: ThanksPage } = await import("./page");

const DOWNLOAD = "https://files.example.com/guide-v1.pdf";
const LATER = "https://files.example.com/guide-v2.pdf";

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  seedConnection();
  mem.seed(`subAccounts/${SA}`, {
    agencyId: "ag1",
    name: "Fixture",
    sellOnlineEnabledByAgency: true,
    paymentsEnabledByAgency: true,
    stripeConnectionMeta: { ready: true },
  });
  mem.seed("products/p1", {
    subAccountId: SA,
    agencyId: "ag1",
    name: "Fibre guide",
    description: "",
    unitPriceCents: 49_900,
    currency: "USD",
    active: true,
    sellOnline: true,
    slug: "fibre-guide",
    delivery: { type: "download", url: DOWNLOAD, label: "Get the guide" },
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("session → paid webhook → thanks page shows the snapshotted download, and the email carries it", async () => {
  const res = await sessionPOST(
    new Request(`https://app.test/api/co/${SA}/buy/fibre-guide/session`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.7" },
      body: "{}",
    }),
    { params: Promise.resolve({ subAccountId: SA, slug: "fibre-guide" }) },
  );
  expect(res.status).toBe(200);
  const call = stripe.createCheckoutSessionForSubAccount.mock.calls[0] as unknown as [{ params: { success_url: string } }];
  const success = new URL(call[0].params.success_url);
  const search = { order: success.searchParams.get("order")!, t: success.searchParams.get("t")! };
  const render = async () =>
    renderToStaticMarkup(
      (await ThanksPage({
        params: Promise.resolve({ subAccountId: SA, slug: "fibre-guide" }),
        searchParams: Promise.resolve(search),
      })) as ReactElement,
    );

  // Before the webhook: processing, no download.
  expect(await render()).not.toContain(DOWNLOAD);

  // The operator swaps the file after the sale opened: the buyer still gets what they bought.
  mem.seed("products/p1", { ...mem.read("products/p1"), delivery: { type: "download", url: LATER } });
  const paid = session("cs_seam_1", {
    amount_total: 49_900,
    currency: "usd",
    customer_details: { email: "buyer@example.com", name: "Bea", phone: null },
  });
  expect((await deliver("checkout.session.completed", paid)).status).toBe(200);
  await flushAfterResponse();

  const html = await render();
  expect(html).toContain(`href="${DOWNLOAD}"`);
  expect(html).toContain("Get the guide");
  expect(html).not.toContain(LATER);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect((sendEmail.mock.calls[0] as unknown as [{ text: string }])[0].text).toContain(DOWNLOAD);
});
