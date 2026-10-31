// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The operator's actions on a signed document, through the real detail
 * component: no Delete (rules refuse it too), no Edit, and no Re-send on the
 * signed quote — including on the draft invoice it was converted to, which
 * keeps the signature. An unsigned draft keeps all of them.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/firestore/quotes", () => ({ deleteQuote: vi.fn(), updateDraftQuote: vi.fn() }));
vi.mock("@/lib/firestore/deals", () => ({ subscribeToDeals: () => () => undefined }));
vi.mock("@/lib/firestore/products", () => ({ subscribeToProducts: () => () => undefined }));
vi.mock("@/components/payments/paystack-invoice-link-button", () => ({ PaystackInvoiceLinkButton: () => null }));
vi.mock("@/components/quotes/recheck-card-charge-button", () => ({ RecheckCardChargeButton: () => null }));

const { QuoteDetail } = await import("./quote-detail");

let root: Root;
let host: HTMLDivElement;

const SIGNATURE = { signerName: "Jane Doe", signedAsNumber: "Q-1", signerEmail: null, signedAt: null, ipAddress: null, userAgent: null, documentHash: "a".repeat(64), hashVersion: 1 };
const QUOTE = {
  id: "q1", agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", quoteNumber: "Q-1", kind: "quote",
  status: "draft", currency: "ZAR", lineItems: [{ id: "l1", description: "Install", quantity: 1, unitPrice: 100 }],
  globalDiscount: null, globalTaxPercent: null, termsAndNotes: "", billedToOrganization: null, billingAddress: null,
  validUntil: null, paymentDueDays: null, autoCreateDealOnAccept: false, dealId: null, signature: null,
  createdAt: null, updatedAt: null, sentAt: null, viewedAt: null, acceptedAt: null, declinedAt: null, declineReason: null,
  declineNote: null, paidAt: null, convertedFromQuoteAt: null, paymentLinkUrl: null, paymentLinkId: null,
  paymentLinkMintedAt: null, publicTokenHash: "",
};

async function buttons(quote: Record<string, unknown>): Promise<string[]> {
  await act(async () => {
    root.render(createElement(QuoteDetail, { quote: quote as never, scope: { agencyId: "ag1", subAccountId: "sa1" }, contactName: "Ann", listHref: "/q" }));
  });
  return [...host.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("an unsigned draft (control): Delete, Edit and Send", async () => {
  const b = await buttons(QUOTE);
  expect(b).toEqual(expect.arrayContaining(["Delete", "Edit"]));
  expect(b.some((t) => /Send/.test(t))).toBe(true);
});

it("the draft invoice converted from a signed quote: no Delete, no Edit", async () => {
  const b = await buttons({ ...QUOTE, kind: "invoice", quoteNumber: "INV-1", signature: SIGNATURE });
  expect(b).not.toContain("Delete");
  expect(b).not.toContain("Edit");
  expect(host.textContent).toContain("Signed by");
});

it("a signed quote: no Delete, no Edit, no Re-send", async () => {
  const b = await buttons({ ...QUOTE, status: "sent", signature: SIGNATURE });
  expect(b).not.toContain("Delete");
  expect(b).not.toContain("Edit");
  expect(b.some((t) => /Send|Re-send/.test(t))).toBe(false);
});
