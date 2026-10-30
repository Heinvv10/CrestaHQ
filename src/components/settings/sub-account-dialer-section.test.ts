// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settings → Phone dialer. Locked while the agency gate is off; asks for
 * dedicated Twilio first; then Enable (POST), the recording toggle (PATCH) and
 * Disable (DELETE) each call the dialer route and surface its errors.
 */

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    subAccount: null as Record<string, unknown> | null,
    isAdmin: true,
    loading: false,
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("sonner", () => ({ toast }));

const { SubAccountDialerSection } = await import("./sub-account-dialer-section");

const TWILIO = { enabled: true, accountSid: `AC${"0a".repeat(16)}`, authTokenSet: true, fromNumber: "+15017122661" };
const LOCKED = "Locked by your agency.";
const TWILIO_FIRST = "enable a dedicated Twilio number";

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;

function setCtx(subAccount: Record<string, unknown> | null, over: Partial<typeof ctx.value> = {}) {
  ctx.value = { subAccountId: "sa1", isAdmin: true, loading: false, ...over, subAccount };
}
async function render() {
  await act(async () => {
    root.render(createElement(SubAccountDialerSection));
  });
}
const text = () => container.textContent ?? "";
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) ?? null;
const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
async function click(el: HTMLElement | null) {
  expect(el).not.toBeNull();
  await act(async () => el!.click());
}
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const calls = () => fetchMock.mock.calls.map(([url, init]) => [init?.method, url, init?.body]);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  toast.success.mockReset();
  toast.error.mockReset();
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SubAccountDialerSection — who sees what", () => {
  it("renders nothing for a non-admin", async () => {
    setCtx({ dialerEnabledByAgency: true, twilioConfig: TWILIO }, { isAdmin: false });
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("does not show locked while the workspace is loading", async () => {
    setCtx(null, { loading: true });
    await render();
    expect(text()).toContain("Phone dialer");
    expect(text()).not.toContain(LOCKED);
    expect(button("Enable dialer")).toBeNull();
  });

  it.each([
    ["off", { dialerEnabledByAgency: false, twilioConfig: TWILIO }],
    ["missing on a legacy doc", { twilioConfig: TWILIO }],
    ["a truthy non-boolean", { dialerEnabledByAgency: 1, twilioConfig: TWILIO }],
  ])("is locked with the gate %s — no Enable, no recording toggle, even with Twilio ready", async (_name, sub) => {
    setCtx(sub);
    await render();
    expect(text()).toContain(LOCKED);
    expect(text()).toContain("ask your agency owner to enable");
    expect(button("Enable dialer")).toBeNull();
    expect(checkbox()).toBeNull();
    expect(button("Disable")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("locked with a dialer already provisioned: still no controls, but it can be removed", async () => {
    setCtx({ dialerEnabledByAgency: false, twilioConfig: TWILIO, dialerConfig: { enabled: true, recordCalls: true } });
    await render();
    expect(text()).toContain(LOCKED);
    expect(button("Enable dialer")).toBeNull();
    expect(checkbox()).toBeNull();
    await click(button("Disable"));
    expect(calls()).toEqual([["DELETE", "/api/sub-accounts/sa1/dialer", undefined]]);
    expect(toast.success).toHaveBeenCalledWith("Dialer disabled.");
  });

  it.each([
    ["no Twilio config", { dialerEnabledByAgency: true }],
    ["dedicated Twilio switched off", { dialerEnabledByAgency: true, twilioConfig: { ...TWILIO, enabled: false } }],
    ["Twilio on but no stored token", { dialerEnabledByAgency: true, twilioConfig: { ...TWILIO, authTokenSet: false } }],
    ["Twilio on but no from number", { dialerEnabledByAgency: true, twilioConfig: { ...TWILIO, fromNumber: "" } }],
  ])("asks for dedicated Twilio first with %s", async (_name, sub) => {
    setCtx(sub);
    await render();
    expect(text()).toContain(TWILIO_FIRST);
    expect(text()).not.toContain(LOCKED);
    expect(button("Enable dialer")).toBeNull();
    expect(checkbox()).toBeNull();
    expect(button("Disable")).toBeNull();
  });

  it("Twilio switched off after provisioning: guidance, and the dialer can still be removed", async () => {
    setCtx({
      dialerEnabledByAgency: true,
      twilioConfig: { ...TWILIO, enabled: false },
      dialerConfig: { enabled: true, recordCalls: false },
    });
    await render();
    expect(text()).toContain(TWILIO_FIRST);
    expect(checkbox()).toBeNull();
    await click(button("Disable"));
    // The confirm says the remote key + app cannot be removed in this state.
    expect(String(confirmMock.mock.calls[0][0])).toContain("can't be removed automatically");
    expect(calls()).toEqual([["DELETE", "/api/sub-accounts/sa1/dialer", undefined]]);
  });

  it("gate on and Twilio ready, not yet provisioned: offers Enable only", async () => {
    setCtx({ dialerEnabledByAgency: true, twilioConfig: TWILIO });
    await render();
    expect(text()).not.toContain(LOCKED);
    expect(text()).not.toContain(TWILIO_FIRST);
    expect(button("Enable dialer")).not.toBeNull();
    expect(checkbox()).toBeNull();
    expect(button("Disable")).toBeNull();
  });
});

describe("SubAccountDialerSection — the three routes", () => {
  const provisioned = (recordCalls: boolean) => ({
    dialerEnabledByAgency: true,
    twilioConfig: TWILIO,
    dialerConfig: { enabled: true, recordCalls },
  });

  it("Enable POSTs the dialer route with no body", async () => {
    setCtx({ dialerEnabledByAgency: true, twilioConfig: TWILIO });
    await render();
    await click(button("Enable dialer"));
    expect(calls()).toEqual([["POST", "/api/sub-accounts/sa1/dialer", undefined]]);
    expect(toast.success).toHaveBeenCalledWith("Dialer enabled. The Call button now shows on contact profiles.");
    expect(toast.error).not.toHaveBeenCalled();
    expect(button("Enable dialer")!.disabled).toBe(false);
  });

  it("Enable is disabled while its request is in flight, so it cannot provision twice", async () => {
    let release!: () => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (release = () => resolve(ok()))));
    setCtx({ dialerEnabledByAgency: true, twilioConfig: TWILIO });
    await render();
    await click(button("Enable dialer"));
    expect(button("Enable dialer")!.disabled).toBe(true);
    await click(button("Enable dialer"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(button("Enable dialer")!.disabled).toBe(false);
  });

  it("the recording toggle PATCHes {recordCalls} both ways", async () => {
    setCtx(provisioned(false));
    await render();
    expect(checkbox()!.checked).toBe(false);
    await click(checkbox());
    expect(calls()).toEqual([["PATCH", "/api/sub-accounts/sa1/dialer", JSON.stringify({ recordCalls: true })]]);
    expect(toast.success).toHaveBeenCalledWith("Call recording on.");

    fetchMock.mockClear();
    setCtx(provisioned(true));
    await render();
    expect(checkbox()!.checked).toBe(true);
    await click(checkbox());
    expect(calls()).toEqual([["PATCH", "/api/sub-accounts/sa1/dialer", JSON.stringify({ recordCalls: false })]]);
    expect(toast.success).toHaveBeenCalledWith("Call recording off.");
  });

  it("the recording box shows the stored value, not the click, when the PATCH fails", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "Enable the dialer first." }), { status: 400 }));
    setCtx(provisioned(false));
    await render();
    await click(checkbox());
    expect(toast.error).toHaveBeenCalledWith("Enable the dialer first.");
    expect(checkbox()!.checked).toBe(false);
  });

  it("Disable asks first, then DELETEs; declining sends nothing", async () => {
    setCtx(provisioned(false));
    await render();
    confirmMock.mockReturnValueOnce(false);
    await click(button("Disable"));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(String(confirmMock.mock.calls[0][0])).toContain("removed from your Twilio account");
    expect(fetchMock).not.toHaveBeenCalled();

    await click(button("Disable"));
    expect(calls()).toEqual([["DELETE", "/api/sub-accounts/sa1/dialer", undefined]]);
    expect(toast.success).toHaveBeenCalledWith("Dialer disabled.");
  });

  const gateOff = { error: "The phone dialer is locked by your agency. Ask your agency owner to enable it.", code: "gate_off" };
  it.each([
    ["403 gate_off", () => new Response(JSON.stringify(gateOff), { status: 403 }), gateOff.error],
    ["403 admin only", () => new Response(JSON.stringify({ error: "Sub-account admin only" }), { status: 403 }), "Sub-account admin only"],
    ["400 Twilio not set up", () => new Response(JSON.stringify({ error: "Set up your dedicated Twilio number first (Settings → SMS). The dialer calls through your own Twilio account." }), { status: 400 }), "Set up your dedicated Twilio number first (Settings → SMS). The dialer calls through your own Twilio account."],
    ["502 from Twilio", () => new Response(JSON.stringify({ error: "Authenticate" }), { status: 502 }), "Authenticate"],
    ["500 with an HTML body", () => new Response("<html>oops</html>", { status: 500 }), "Request failed."],
    ["200 that is not ok:true", () => new Response(JSON.stringify({}), { status: 200 }), "Request failed."],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch")), "Failed to fetch"],
  ])("Enable: %s is shown as an error and the button comes back", async (_name, answer, shown) => {
    fetchMock.mockImplementation(async () => answer());
    setCtx({ dialerEnabledByAgency: true, twilioConfig: TWILIO });
    await render();
    await click(button("Enable dialer"));
    expect(toast.error).toHaveBeenCalledWith(shown);
    expect(toast.success).not.toHaveBeenCalled();
    expect(button("Enable dialer")!.disabled).toBe(false);
  });

  it("Disable: a failure is shown as an error and the button comes back", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "Sub-account admin only" }), { status: 403 }));
    setCtx(provisioned(false));
    await render();
    await click(button("Disable"));
    expect(toast.error).toHaveBeenCalledWith("Sub-account admin only");
    expect(toast.success).not.toHaveBeenCalled();
    expect(button("Disable")!.disabled).toBe(false);
  });
});
