// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Reports card's Mystery shop area: a button per channel, disabled with
 * the reason as visible text; the confirm dialog names the exact target, the
 * enquiry and (for a call) the consent line; only its confirm POSTs, with
 * `confirm: true` and the chosen target.
 */

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount: { name: "Cresta HQ" }, subAccountId: "sa1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { ContactMysteryShop } from "./contact-mystery-shop";

const EMAIL = "info@acme.co.za";
const PHONE = "+27821234567";
let payload: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let container: HTMLDivElement;

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ContactMysteryShop, { contactId: "c1" })));
}
async function click(el: HTMLElement | null) {
  await act(async () => el!.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  payload = {
    shops: [],
    channels: {
      email: { available: true, targets: [EMAIL] },
      call: { available: true, targets: [PHONE] },
      whatsapp: { available: false, reason: "No WhatsApp sender is connected.", targets: [PHONE] },
      form: { available: false, reason: "Not available yet.", targets: [] },
    },
    cap: 10,
    used: 0,
    enquiry: {
      email: { subject: "Enquiry: plumber in Gqeberha", body: "Hi,\n\nDo you do plumber?" },
      call: "Hi, I'm calling from Cresta HQ.",
      whatsapp: "Hi, do you offer plumber in Gqeberha? What's your earliest availability?",
    },
    enquiryHash: { email: "h-email", call: "h-call", whatsapp: "h-wa" },
  };
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST" ? new Response(JSON.stringify({ shopId: "s1" }), { status: 202 }) : new Response(JSON.stringify(payload)),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ContactMysteryShop", () => {
  it("disables an unavailable channel with its reason as visible text", async () => {
    await mount();
    expect((q("mystery-shop-email") as HTMLButtonElement).disabled).toBe(false);
    expect((q("mystery-shop-whatsapp") as HTMLButtonElement).disabled).toBe(true);
    expect(q("mystery-shop-whatsapp-reason")?.textContent).toBe("WhatsApp: No WhatsApp sender is connected.");
    expect(q("mystery-shop-form-reason")?.textContent).toBe("Website form: Not available yet.");
  });

  it("a channel with no target, or the cap reached, is disabled", async () => {
    (payload.channels as Record<string, unknown>).email = { available: true, targets: [] };
    payload.used = 10;
    await mount();
    expect((q("mystery-shop-email") as HTMLButtonElement).disabled).toBe(true);
    expect((q("mystery-shop-call") as HTMLButtonElement).disabled).toBe(true);
    expect(q("mystery-shop-email-reason")?.textContent).toBe("Email: This contact has no email address.");
    expect(container.textContent).toContain("limit is used up");
  });

  it("email: the dialog names the target and the full enquiry, and only its confirm POSTs", async () => {
    await mount();
    await click(q("mystery-shop-email"));
    expect(q("mystery-shop-target")?.textContent).toBe(EMAIL);
    expect(q("mystery-shop-enquiry")?.textContent).toBe("Subject: Enquiry: plumber in Gqeberha\n\nHi,\n\nDo you do plumber?");
    expect(q("mystery-shop-consent")).toBeNull();
    expect(posts()).toHaveLength(0);
    await click(q("mystery-shop-confirm-send"));
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1].body as string)).toEqual({
      contactId: "c1", channel: "email", confirm: true, target: EMAIL, enquiryHash: "h-email",
    });
  });

  it("call: the consent checkbox (the Call dialog's wording) gates the button and travels as consentAck", async () => {
    await mount();
    await click(q("mystery-shop-call"));
    expect(q("mystery-shop-consent")?.textContent).toBe(`I confirm Cresta HQ may place this AI call to ${PHONE} now.`);
    expect(q("mystery-shop-consent-ack")?.textContent).toContain("I confirm this contact has consented to receive calls from us");
    const button = q("mystery-shop-confirm-send") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await click(button);
    expect(posts()).toHaveLength(0);
    await click(q("mystery-shop-consent-ack")!.querySelector("input"));
    expect(button.disabled).toBe(false);
    await click(button);
    expect(JSON.parse(posts()[0][1].body as string)).toEqual({
      contactId: "c1", channel: "call", confirm: true, target: PHONE, enquiryHash: "h-call", consentAck: true,
    });
  });

  it("whatsapp: the dialog names the number and the template text, no consent checkbox; the confirm POSTs its hash", async () => {
    (payload.channels as Record<string, unknown>).whatsapp = { available: true, targets: [PHONE] };
    await mount();
    await click(q("mystery-shop-whatsapp"));
    expect(q("mystery-shop-confirm")?.textContent).toContain("Send a mystery-shop WhatsApp?");
    expect(q("mystery-shop-target")?.textContent).toBe(PHONE);
    expect(q("mystery-shop-enquiry")?.textContent).toBe("Hi, do you offer plumber in Gqeberha? What's your earliest availability?");
    expect(q("mystery-shop-consent-ack")).toBeNull();
    expect((q("mystery-shop-confirm-send") as HTMLButtonElement).disabled).toBe(false);
    await click(q("mystery-shop-confirm-send"));
    expect(JSON.parse(posts()[0][1].body as string)).toEqual({
      contactId: "c1", channel: "whatsapp", confirm: true, target: PHONE, enquiryHash: "h-wa",
    });
  });

  it("renders nothing for a contact that is not a prospect", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ code: "not_a_prospect", error: "x" }), { status: 403 }));
    await mount();
    expect(container.innerHTML).toBe("");
  });

  it("a later successful load clears an earlier error", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "Temporarily unavailable" }), { status: 503 }));
    await mount();
    expect(container.textContent).toContain("Temporarily unavailable");
    await click(q("mystery-shop-retry"));
    expect(container.textContent).not.toContain("Temporarily unavailable");
    expect(q("mystery-shop-email")).not.toBeNull();
  });

  it("shows a status line per shop and a refusal's reason", async () => {
    payload.shops = [
      {
        id: "s1", channel: "email", status: "sent", target: EMAIL, sentAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        respondedAt: null, responseMs: null, autoReplyAt: null, jobValueCents: 150_000, currency: "ZAR",
        enquiryText: "", failure: null, createdAt: null,
      },
    ];
    await mount();
    expect(q("mystery-shop-status-s1")?.textContent).toBe(`Email to ${EMAIL} — sent 3 m ago, waiting for a reply (24 h)`);
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ code: "outside_window", error: "It's outside the calling window." }), { status: 403 }),
    );
    await click(q("mystery-shop-call"));
    await click(q("mystery-shop-consent-ack")!.querySelector("input"));
    await click(q("mystery-shop-confirm-send"));
    expect(container.textContent).toContain("It's outside the calling window.");
  });

  it("an unconfirmed miss offers 'Confirm no reply', which POSTs the confirmation; a confirmed one does not", async () => {
    const missed = (id: string, missedConfirmedAt: string | null) => ({
      id, channel: "email", status: "missed", target: EMAIL, sentAt: "2026-10-07T08:00:00.000Z", respondedAt: null,
      responseMs: null, autoReplyAt: null, jobValueCents: 150_000, currency: "ZAR", enquiryText: "", failure: null,
      createdAt: null, missedConfirmedAt,
    });
    payload.shops = [missed("m1", null), missed("m2", "2026-10-08T10:00:00.000Z"), { ...missed("m3", null), sendUncertain: true }];
    await mount();
    expect(q("mystery-shop-confirm-missed-m3")).toBeNull();
    expect(q("mystery-shop-status-m1")?.textContent).toContain("only confirmed misses appear on the report");
    expect(q("mystery-shop-confirm-missed-m2")).toBeNull();
    await click(q("mystery-shop-confirm-missed-m1"));
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/mystery-shop/m1/confirm-missed") && init?.method === "POST")).toBe(true);
  });
});
