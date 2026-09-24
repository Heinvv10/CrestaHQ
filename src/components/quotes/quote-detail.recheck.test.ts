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

const invoice = (state: "unknown" | "declined"): Quote =>
  ({
    id: "inv1",
    kind: "invoice",
    status: "sent",
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
    autoCharge: { reference: "ra-s1-c1", mandateId: null, state, reason: null },
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

it("keeps Paystack's answer on screen after the charge settles and the button goes", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ outcome: "declined" }), { status: 200 }));
  await act(async () => recheckButton()!.click());
  // The live subscription delivers the declined charge.
  await render(invoice("declined"));
  expect(recheckButton()).toBeUndefined();
  expect(container.textContent).toContain("did not go through");
});

it("shows the route's refusal in the view", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Reload and check again." }), { status: 409 }));
  await act(async () => recheckButton()!.click());
  expect(container.textContent).toContain("Reload and check again.");
  // The charge is still unconfirmed, so it can be re-checked again.
  expect(recheckButton()).toBeDefined();
});
