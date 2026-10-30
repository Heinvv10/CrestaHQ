// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicQuoteView } from "@/components/quotes/public-quote-view";
import { computeQuoteDocumentHash } from "@/lib/quotes/signature";
import type { SerializableQuote } from "@/lib/quotes/public-quote";

/**
 * The recipient's accept on /q/[token] when the quote's signature setting
 * changed after the page loaded, driven through the real component with the
 * server's answer stubbed:
 *   - turned on after load: the page has no name field, so the server's 400
 *     must tell the visitor to refresh, not to type a name they can't type;
 *   - turned off after load: the server accepts without a signature, and the
 *     page must not claim one was recorded;
 *   - unchanged: a recorded signature shows who signed, and the page sends
 *     the fingerprint of the content it rendered.
 */

let root: Root;
let host: HTMLDivElement;
let calls: Array<{ url: string; body: Record<string, unknown> }> = [];

const QUOTE = {
  id: "q1", agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", quoteNumber: "Q-2026-0007",
  kind: "quote", status: "viewed", currency: "ZAR",
  lineItems: [{ id: "li1", description: "Fibre install", quantity: 1, unitPrice: 1500 }],
  globalDiscount: null, globalTaxPercent: 15, termsAndNotes: "50% deposit.", billedToOrganization: null, billingAddress: null,
  validUntil: 1_900_000_000_000, paymentDueDays: null, autoCreateDealOnAccept: false, dealId: null, signature: null,
  createdAt: null, updatedAt: null, sentAt: null, viewedAt: null, acceptedAt: null, declinedAt: null, declineReason: null,
  declineNote: null, paidAt: null, convertedFromQuoteAt: null, paymentLinkUrl: null, paymentLinkId: null,
  paymentLinkMintedAt: null, publicTokenHash: "h",
} as unknown as SerializableQuote;

function answer(status: number, body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return { ok: status < 400, status, json: async () => body };
    }),
  );
}

async function render(quote: SerializableQuote) {
  await act(async () => {
    root.render(createElement(PublicQuoteView, { quote, token: "tok", businessName: "Acme", expired: false }));
  });
}

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (text: string) => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
};
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });

/**
 * Until the page has POSTed, then let the answer render. The signed accept
 * hashes with WebCrypto before it posts, which a loaded runner makes slow, so
 * a fixed number of ticks races it.
 */
async function untilPosted() {
  await act(async () => {
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000 });
  });
  await tick();
  await tick();
}

async function signAs(name: string) {
  await click(button("Sign & accept"));
  const input = host.querySelector<HTMLInputElement>("#signer-name")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(host.querySelector('[role="checkbox"]')!);
  await click(button("Accept & sign"));
  await untilPosted();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no PointerEvent; the base-ui checkbox constructs one on click.
  if (typeof window.PointerEvent === "undefined") vi.stubGlobal("PointerEvent", class extends MouseEvent {});
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("a signature switched on after load: the 400 tells the visitor to refresh", async () => {
  answer(400, { error: "Type your full name to sign (2–120 characters)." });
  await render({ ...QUOTE, requireSignature: false });
  await click(button("Accept this quote"));
  await untilPosted();
  expect(host.textContent).toContain("This quote now needs your signature — refresh the page to sign it.");
  expect(host.textContent).not.toContain("Type your full name");
  expect(host.textContent).not.toContain("Quote accepted");
});

it("a signature switched off after load: accepted, and no 'Signed by'", async () => {
  answer(200, { ok: true, status: "accepted" });
  await render({ ...QUOTE, requireSignature: true });
  await signAs("Jane Doe");
  expect(calls).toHaveLength(1);
  expect(host.textContent).toContain("Quote accepted — thank you!");
  expect(host.textContent).not.toContain("Signed by");
});

it("a recorded signature: 'Signed by', and the page sent the fingerprint of what it rendered", async () => {
  answer(200, { ok: true, status: "accepted", signed: true });
  await render({ ...QUOTE, requireSignature: true });
  await signAs("  Jane   Doe ");
  expect(calls[0].body).toEqual({
    action: "accept",
    signerName: "Jane Doe",
    agreedToTerms: true,
    documentHash: await computeQuoteDocumentHash(QUOTE),
  });
  expect(host.textContent).toContain("Signed by Jane Doe.");
});

it("a signed page's own 400 (stale fingerprint) shows the server's message", async () => {
  answer(400, { error: "This page is out of date — refresh it and sign again." });
  await render({ ...QUOTE, requireSignature: true });
  await signAs("Jane Doe");
  expect(host.textContent).toContain("This page is out of date — refresh it and sign again.");
});
