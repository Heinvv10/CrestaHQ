// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceSdk } from "@/test/fake-voice-sdk";
import type { Contact } from "@/types/contacts";

/**
 * The contact profile's browser Call button (Softphone v1), through the real
 * header and the real call bar: shown only with the agency gate on AND the
 * dialer provisioned; disabled, with the reason, for a contact the server
 * would refuse; and the Voice SDK is loaded only once a call has its token.
 */

let subAccount: Record<string, unknown> | null;

vi.mock("@twilio/voice-sdk", async () => (await import("@/test/fake-voice-sdk")).fakeVoiceSdkModule());
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount, subAccountId: "sa1", isAdmin: true, saPath: (p: string) => `/sa/sa1${p}` }),
}));
vi.mock("@/hooks/use-sub-account-members", () => ({ useSubAccountMembers: () => ({ members: [] }) }));
vi.mock("@/lib/firestore/territories", () => ({ subscribeToTerritories: () => () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Siblings with their own tests and their own data needs.
vi.mock("@/components/contacts/contact-form", () => ({ ContactForm: () => null }));
vi.mock("@/components/contacts/send-email-dialog", () => ({ SendEmailDialog: () => null }));
vi.mock("@/components/contacts/send-sms-dialog", () => ({ SendSmsDialog: () => null }));
vi.mock("@/components/contacts/send-call-dialog", () => ({ SendCallDialog: () => null }));
vi.mock("@/components/contacts/link-contact-button", () => ({ LinkContactButton: () => null }));

const { ContactProfileHeader } = await import("./contact-profile-header");
// Importing the header (and, through it, the call bar) must not load the SDK.
const sdkLoadsAfterImport = voiceSdk.loads;

const TOKEN = "eyJ.fake-dialer-token.sig";
const READY = { dialerEnabledByAgency: true, dialerConfig: { enabled: true, recordCalls: false } };
const base = {
  id: "c1",
  name: "Thandi Mokoena",
  email: "thandi@example.test",
  phone: "+27821234567",
  company: "",
  address: "",
  source: "manual",
  tags: [],
  pipelineStage: null,
  attribution: null,
  createdAt: null,
} as unknown as Contact;

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

const callButton = () => container.querySelector<HTMLButtonElement>('[data-testid="browser-call-button"]');
const bar = () => container.querySelector<HTMLElement>('[data-testid="browser-call-bar"]');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function render(contact: Partial<Contact> = {}) {
  await act(async () => {
    root.render(createElement(ContactProfileHeader, { contact: { ...base, ...contact } as Contact }));
  });
}
async function until(cond: () => boolean, label: string) {
  for (let i = 0; i < 200 && !cond(); i++) await act(async () => tick());
  expect(cond(), label).toBe(true);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voiceSdk.reset();
  subAccount = { ...READY };
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, token: TOKEN, ttlSeconds: 3600 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("contact profile — the browser Call button", () => {
  it("is shown and enabled with the gate on, the dialer provisioned and a +… number", async () => {
    await render();
    expect(callButton()).not.toBeNull();
    expect(callButton()!.disabled).toBe(false);
    expect(callButton()!.title).toBe("Call from your browser");
    expect(callButton()!.textContent).toContain("Call");
    // The header rendered; the other buttons are there to be told apart from.
    expect(container.textContent).toContain("Thandi Mokoena");
    expect(container.textContent).toContain("SMS");
  });

  it.each([
    ["the agency gate off, dialer provisioned", { dialerEnabledByAgency: false, dialerConfig: { enabled: true, recordCalls: false } }],
    ["the agency gate missing (legacy doc), dialer provisioned", { dialerConfig: { enabled: true, recordCalls: false } }],
    ["the agency gate a truthy non-boolean", { dialerEnabledByAgency: "true", dialerConfig: { enabled: true, recordCalls: false } }],
    ["the gate on, dialer not provisioned", { dialerEnabledByAgency: true, dialerConfig: null }],
    ["the gate on, dialer switched off", { dialerEnabledByAgency: true, dialerConfig: { enabled: false, recordCalls: false } }],
    ["the gate on, no dialerConfig at all", { dialerEnabledByAgency: true }],
  ])("is absent with %s", async (_name, sub) => {
    subAccount = sub;
    await render();
    expect(container.textContent).toContain("Thandi Mokoena");
    expect(callButton()).toBeNull();
    expect(bar()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is absent while the workspace doc has not loaded", async () => {
    subAccount = null;
    await render();
    expect(callButton()).toBeNull();
  });

  it.each([
    ["no phone", { phone: "" }, "No phone on this contact"],
    ["opted out of calls", { voiceOptedOut: true }, "This contact opted out of calls"],
    ["a locally formatted number", { phone: "082 123 4567" }, "Save the number in international format, e.g. +27…"],
    ["digits with a country code but no +", { phone: "27821234567" }, "Save the number in international format, e.g. +27…"],
    ["opted out AND locally formatted", { phone: "082 123 4567", voiceOptedOut: true }, "This contact opted out of calls"],
  ])("is disabled with the reason for a contact with %s", async (_name, contact, reason) => {
    await render(contact as Partial<Contact>);
    expect(callButton()).not.toBeNull();
    expect(callButton()!.disabled).toBe(true);
    expect(callButton()!.title).toBe(reason);
    await act(async () => callButton()!.click());
    expect(bar()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voiceOptedOut: false does not disable it", async () => {
    await render({ voiceOptedOut: false });
    expect(callButton()!.disabled).toBe(false);
  });

  it("nothing is requested until the click; then the token, then the SDK, then the call", async () => {
    expect(sdkLoadsAfterImport).toBe(0);
    let releaseToken!: () => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseToken = () => resolve(new Response(JSON.stringify({ ok: true, token: TOKEN }), { status: 200 }));
        }),
    );
    await render();
    for (let i = 0; i < 5; i++) await act(async () => tick());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(voiceSdk.loads).toBe(0);
    expect(bar()).toBeNull();

    await act(async () => callButton()!.click());
    expect(bar()?.dataset.phase).toBe("connecting");
    expect(callButton()!.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/comms/dialer/token");
    // Token still outstanding: the SDK has not been loaded.
    for (let i = 0; i < 5; i++) await act(async () => tick());
    expect(voiceSdk.loads).toBe(0);
    expect(voiceSdk.devices).toHaveLength(0);

    releaseToken();
    await until(() => bar()?.dataset.phase === "ringing", "ringing");
    expect(voiceSdk.loads).toBe(1);
    expect(voiceSdk.device.connectOpts).toEqual({ params: { contactId: "c1" } });
  });

  it("a refused token shows in the bar; closing it gives the button back", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ error: "The phone dialer is locked by your agency. Ask your agency owner to enable it.", code: "gate_off" }), { status: 403 }),
    );
    await render();
    await act(async () => callButton()!.click());
    await until(() => bar()?.dataset.phase === "error", "error");
    expect(bar()!.textContent).toContain("locked by your agency");
    const close = [...bar()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Close");
    await act(async () => close!.click());
    expect(bar()).toBeNull();
    expect(callButton()!.disabled).toBe(false);
  });

  it("showing another contact ends the call instead of dialling them", async () => {
    await render();
    await act(async () => callButton()!.click());
    await until(() => bar()?.dataset.phase === "ringing", "ringing");
    const device = voiceSdk.device;
    const tokenRequests = fetchMock.mock.calls.length;

    await render({ id: "c2", name: "Someone Else", phone: "+27829999999" });
    expect(bar()).toBeNull();
    expect(device.destroyCalls).toBe(1);
    for (let i = 0; i < 5; i++) await act(async () => tick());
    expect(voiceSdk.devices).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBe(tokenRequests);
    expect(callButton()!.disabled).toBe(false);
  });

  it("an open call survives the gate being switched off; the button goes", async () => {
    await render();
    await act(async () => callButton()!.click());
    await until(() => bar()?.dataset.phase === "ringing", "ringing");
    subAccount = { ...READY, dialerEnabledByAgency: false };
    await render();
    expect(callButton()).toBeNull();
    expect(bar()).not.toBeNull();
    expect(voiceSdk.device.destroyCalls).toBe(0);
  });
});
