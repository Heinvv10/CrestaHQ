// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Quote } from "@/types/quotes";

/**
 * The invoice view shows the button only while the card charge is pending or
 * unknown. Its live subscription flips that state the moment the re-check
 * records Paystack's answer, unmounting the button, so the answer has to
 * survive in the view itself.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/firestore/quotes", () => ({ deleteQuote: vi.fn(), updateDraftQuote: vi.fn() }));
vi.mock("@/lib/firestore/deals", () => ({ subscribeToDeals: vi.fn(() => () => {}) }));
vi.mock("@/lib/firestore/products", () => ({ subscribeToProducts: vi.fn(() => () => {}) }));
vi.mock("@/components/payments/paystack-invoice-link-button", () => ({ PaystackInvoiceLinkButton: () => null }));

const { QuoteDetail } = await import("./quote-detail");

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

const invoice = (
  state: "unknown" | "pending" | "declined" | "paid" | "needs_attention",
  status: "sent" | "viewed" | "paid" = "sent",
  reason: string | null = null,
): Quote =>
  ({
    id: "inv1",
    kind: "invoice",
    status,
    quoteNumber: "INV-1",
    currency: "ZAR",
    contactId: "c1",
    agencyId: "a1",
    subAccountId: "sa1",
    lineItems: [{ description: "Item", quantity: 1, unitPrice: 10 }],
    globalDiscount: null,
    globalTaxPercent: 0,
    termsAndNotes: "",
    paymentDueDays: 7,
    createdAt: null,
    updatedAt: null,
    autoCharge: { reference: "ra-s1-c1", mandateId: null, state, reason },
  }) as unknown as Quote;

const render = (quote: Quote) =>
  act(async () =>
    root.render(
      createElement(QuoteDetail, {
        quote,
        scope: { agencyId: "a1", subAccountId: "sa1" } as never,
        contactName: "Test",
        listHref: "/q",
      }),
    ),
  );

const recheckButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Re-check card charge"));

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await render(invoice("unknown"));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const answer = (body: object, status = 200) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
const click = () => act(async () => recheckButton()!.click());

it("keeps a declined answer on screen after its own write unmounts the button", async () => {
  answer({ outcome: "declined" });
  await click();
  // The live subscription delivers the declined charge after the response.
  await render(invoice("declined", "sent", "Paystack has no record of this charge"));
  expect(recheckButton()).toBeUndefined();
  expect(container.textContent).toContain("did not go through");
  // The answer stands in for the charge line; never both.
  expect(container.textContent).not.toContain("Card charge failed");
});

it("shows a declined answer before its own write reaches the view", async () => {
  answer({ outcome: "declined" });
  await click();
  expect(container.textContent).toContain("did not go through");
});

it("keeps the answer when the subscription lands before the response", async () => {
  let respond!: (r: Response) => void;
  fetchMock.mockReturnValue(new Promise<Response>((r) => (respond = r)));
  await click();
  await render(invoice("declined"));
  await act(async () => respond(new Response(JSON.stringify({ outcome: "declined" }), { status: 200 })));
  expect(container.textContent).toContain("did not go through");
});

it("keeps a paid answer once the invoice turns paid", async () => {
  answer({ outcome: "paid" });
  await click();
  await render(invoice("paid", "paid"));
  expect(container.textContent).toContain("the invoice is now paid");
});

it("drops the answer when the invoice changes again afterwards", async () => {
  answer({ outcome: "declined" });
  await click();
  await render(invoice("declined"));
  // Later marked paid by hand.
  await render(invoice("declined", "paid"));
  expect(container.textContent).not.toContain("did not go through");
});

it("drops a refusal when a webhook settles the charge afterwards", async () => {
  answer({ error: "Reload and check again." }, 409);
  await click();
  expect(container.textContent).toContain("Reload and check again.");
  // The charge is still unconfirmed, so it can be re-checked again.
  expect(recheckButton()).toBeDefined();
  await render(invoice("paid", "paid"));
  expect(container.textContent).not.toContain("Reload and check again.");
});

it("keeps a paid answer through the status write that lands before the charge write", async () => {
  answer({ outcome: "paid" });
  await click();
  await render(invoice("unknown", "paid"));
  expect(container.textContent).toContain("the invoice is now paid");
  await render(invoice("paid", "paid"));
  expect(container.textContent).toContain("the invoice is now paid");
});

it("keeps a needs-attention answer after its own write unmounts the button", async () => {
  answer({ outcome: "needs_attention" });
  await click();
  await render(invoice("needs_attention"));
  expect(recheckButton()).toBeUndefined();
  expect(container.textContent).toContain("couldn't be recorded against this invoice");
});

it("keeps a pending answer while nothing changes, and drops it when the charge settles", async () => {
  answer({ outcome: "pending" });
  await click();
  expect(container.textContent).toContain("no final answer yet");
  await render(invoice("paid", "paid"));
  expect(container.textContent).not.toContain("no final answer yet");
});

it("matches a declined answer against the status when it arrives, not when clicked", async () => {
  let respond!: (r: Response) => void;
  fetchMock.mockReturnValue(new Promise<Response>((r) => (respond = r)));
  await click();
  // The customer opens the invoice while the re-check is in flight.
  await render(invoice("unknown", "viewed"));
  await act(async () => respond(new Response(JSON.stringify({ outcome: "declined" }), { status: 200 })));
  await render(invoice("declined", "viewed"));
  expect(container.textContent).toContain("did not go through");
});

it("drops a pending answer when something else changed the invoice mid-flight", async () => {
  let respond!: (r: Response) => void;
  fetchMock.mockReturnValue(new Promise<Response>((r) => (respond = r)));
  await click();
  // Marked paid by hand while the re-check was in flight.
  await render(invoice("unknown", "paid"));
  await act(async () => respond(new Response(JSON.stringify({ outcome: "pending" }), { status: 200 })));
  expect(container.textContent).not.toContain("no final answer yet");
});

it("keeps a declined answer when an unrelated status change arrives with the charge write", async () => {
  answer({ outcome: "declined" });
  await click();
  // One snapshot carries the customer opening the invoice and the decline.
  await render(invoice("declined", "viewed"));
  expect(container.textContent).toContain("did not go through");
});

it("keeps a failed-but-paid answer on the hand-paid invoice", async () => {
  answer({ outcome: "failed_but_paid" });
  await click();
  await render(invoice("unknown", "paid"));
  await render(invoice("declined", "paid"));
  expect(container.textContent).toContain("already marked paid by hand");
});

it("drops a pending answer when the daily sweep later declines the charge", async () => {
  answer({ outcome: "pending" });
  await click();
  expect(container.textContent).toContain("no final answer yet");
  await render(invoice("declined"));
  expect(container.textContent).not.toContain("no final answer yet");
});

it("keeps a needs-attention answer on an invoice marked paid by hand mid-flight", async () => {
  answer({ outcome: "needs_attention" });
  await click();
  await render(invoice("needs_attention", "paid"));
  expect(container.textContent).toContain("couldn't be recorded against this invoice");
});

it("says why a card charge was declined once the re-check answer is gone", async () => {
  await render(invoice("declined", "sent", "Paystack reports the charge failed"));
  expect(recheckButton()).toBeUndefined();
  expect(container.textContent).toContain("Card charge failed: Paystack reports the charge failed");
});

it("tells another operator the charge was declined when their own re-check is refused", async () => {
  answer({ error: "This card charge changed while it was being re-checked. Reload and check again." }, 409);
  await click();
  await render(invoice("declined", "sent", "Paystack has no record of this charge"));
  expect(container.textContent).not.toContain("Reload and check again");
  expect(container.textContent).toContain("Card charge failed: Paystack has no record of this charge");
});

it("shows a needs-attention charge's reason", async () => {
  await render(invoice("needs_attention", "sent", "Paystack later reported this charge as paid"));
  expect(container.textContent).toContain("Card charge needs attention: Paystack later reported this charge as paid");
});

it("says nothing about a declined charge once the invoice was paid another way", async () => {
  await render(invoice("declined", "paid", "Insufficient funds"));
  expect(container.textContent).not.toContain("Card charge failed");
});

it("drops a needs-attention line once the invoice is paid — recording the payment resolves it", async () => {
  await render(invoice("needs_attention", "paid", "Record it as this invoice's payment"));
  expect(container.textContent).not.toContain("Card charge needs attention");
});
