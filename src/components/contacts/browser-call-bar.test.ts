// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceSdk } from "@/test/fake-voice-sdk";
import type { Contact } from "@/types/contacts";

/**
 * The in-call bar's state machine with the Voice SDK mocked at the module
 * seam: connecting → ringing → in call → ended; every answer the token route
 * can give ends in a shown error with no Device; and every way out destroys
 * the Device — an error, the call ending, Hang up, unmount.
 */

vi.mock("@twilio/voice-sdk", async () => (await import("@/test/fake-voice-sdk")).fakeVoiceSdkModule());

const { BrowserCallBar } = await import("./browser-call-bar");

const TOKEN = "eyJ.fake-dialer-token.sig";
const contact = { id: "c1", name: "Thandi Mokoena", phone: "+27821234567" } as Contact;
const realSetTimeout = globalThis.setTimeout;
const tick = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));

let root: Root;
let container: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let fetchMock: ReturnType<typeof vi.fn>;
let mounted = false;

const bar = () => container.querySelector<HTMLElement>('[data-testid="browser-call-bar"]');
const phase = () => bar()?.dataset.phase;
const status = () => container.querySelector('[data-testid="browser-call-status"]')?.textContent;
const clock = () => container.querySelector('[data-testid="browser-call-clock"]')?.textContent ?? null;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.title === name) ?? null;

async function mount() {
  await act(async () => {
    root.render(createElement(BrowserCallBar, { contact, subAccountId: "sa1", onClose }));
  });
  mounted = true;
}
async function unmount() {
  if (!mounted) return;
  mounted = false;
  await act(async () => root.unmount());
}
/** Let pending fetches / the dynamic import / connect resolve, until `cond`. */
async function until(cond: () => boolean, label: string) {
  for (let i = 0; i < 200 && !cond(); i++) await act(async () => tick());
  expect(cond(), label).toBe(true);
}
async function emit(target: { emit(event: string, ...args: unknown[]): void }, event: string, ...args: unknown[]) {
  await act(async () => target.emit(event, ...args));
}
async function click(el: HTMLElement | null) {
  expect(el).not.toBeNull();
  await act(async () => el!.click());
}
const tokenOk = () => new Response(JSON.stringify({ ok: true, token: TOKEN, ttlSeconds: 3600 }), { status: 200 });
async function mountToRinging() {
  await mount();
  await until(() => phase() === "ringing" && voiceSdk.devices.length === 1, "ringing");
  await act(async () => tick());
  return voiceSdk.device;
}
async function mountToInCall() {
  const device = await mountToRinging();
  await emit(device.call, "accept");
  expect(phase()).toBe("in-call");
  return device;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  voiceSdk.reset();
  // Re-register the mock, so this test's first import() of the SDK loads it
  // afresh and the load count does not depend on test order.
  vi.doMock("@twilio/voice-sdk", async () => (await import("@/test/fake-voice-sdk")).fakeVoiceSdkModule());
  onClose = vi.fn<() => void>();
  fetchMock = vi.fn(async () => tokenOk());
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await unmount();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BrowserCallBar — a call that goes through", () => {
  it("connecting → ringing → in call → ended, then closes itself", async () => {
    let releaseToken!: () => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (releaseToken = () => resolve(tokenOk()))));
    await mount();
    expect(phase()).toBe("connecting");
    expect(status()).toBe("Connecting…");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/comms/dialer/token",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ subAccountId: "sa1" }) }),
    );
    // No token yet: nothing has been constructed.
    expect(voiceSdk.devices).toHaveLength(0);

    releaseToken();
    await until(() => phase() === "ringing", "ringing");
    const device = voiceSdk.device;
    expect(device.token).toBe(TOKEN);
    expect(device.connectOpts).toEqual({ params: { contactId: "c1" } });
    expect(status()).toBe("Ringing…");
    await act(async () => tick());

    await emit(device.call, "accept");
    expect(phase()).toBe("in-call");
    expect(status()).toBe("In call");
    expect(clock()).toBe(" · 0:00");
    await act(async () => vi.advanceTimersByTime(65_000));
    expect(clock()).toBe(" · 1:05");

    await emit(device.call, "disconnect");
    expect(phase()).toBe("ended");
    expect(status()).toBe("Call ended");
    expect(clock()).toBeNull();
    expect(device.destroyCalls).toBe(1);
    // The clock stops with the call.
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(status()).toBe("Call ended");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(500));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a call cancelled before it is answered also ends and destroys the device", async () => {
    const device = await mountToRinging();
    await emit(device.call, "cancel");
    expect(phase()).toBe("ended");
    expect(device.destroyCalls).toBe(1);
  });

  it("keeps the token in memory only: not in storage, the DOM or the console", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(...args));
    }
    const device = await mountToInCall();
    await emit(device.call, "disconnect");
    expect(device.token).toBe(TOKEN);
    expect(JSON.stringify([{ ...localStorage }, { ...sessionStorage }])).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
    expect(logged.map(String).join("\n")).not.toContain(TOKEN);
  });

  it("mute and the keypad drive the live call", async () => {
    const device = await mountToInCall();
    await click(button("Mute"));
    expect(device.call.muted).toBe(true);
    await click(button("Mute"));
    expect(device.call.muted).toBe(false);
    await click(button("Keypad"));
    await click(button("5"));
    expect(device.call.digits).toEqual(["5"]);
  });
});

describe("BrowserCallBar — every answer from the token route", () => {
  const json = (statusCode: number, body: unknown) => () =>
    new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } });
  const html = (statusCode: number) => () =>
    new Response("<!doctype html><html><body>nope</body></html>", { status: statusCode, headers: { "content-type": "text/html" } });
  const GENERIC = "Couldn't authorize the call.";
  const LOCKED = "The phone dialer is locked by your agency. Ask your agency owner to enable it.";
  const TWILIO_OFF = "Dedicated Twilio is switched off for this workspace, so the dialer can't place calls.";
  const UNPROVISIONED = "The dialer isn't fully provisioned — re-enable it in Settings.";

  const cases: [string, () => Response | Promise<Response>, string][] = [
    ["403 gate_off", json(403, { error: LOCKED, code: "gate_off" }), LOCKED],
    ["403 not a member", json(403, { error: "Not a member" }), "Not a member"],
    ["403 Twilio switched off", json(403, { error: TWILIO_OFF }), TWILIO_OFF],
    ["404", json(404, { error: "Sub-account not found" }), "Sub-account not found"],
    ["503 with a JSON body", json(503, { error: UNPROVISIONED }), UNPROVISIONED],
    ["500 with an HTML body", html(500), GENERIC],
    ["502 with an empty body", () => new Response(null, { status: 502 }), GENERIC],
    ["a login redirect answered as 200 HTML", html(200), GENERIC],
    ["200 without a token", json(200, { ok: true }), GENERIC],
    ["200 with a token but ok false", json(200, { ok: false, token: TOKEN }), GENERIC],
    ["an error status that still carries a token", json(403, { ok: true, token: TOKEN }), GENERIC],
    ["a non-string error", json(500, { error: { nested: true } }), GENERIC],
    ["a JSON null", json(500, null), GENERIC],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch")), "Couldn't reach the server. Check your connection and try again."],
  ];

  it.each(cases)("%s → the error is shown, nothing is left calling", async (_name, answer, shown) => {
    fetchMock.mockImplementation(async () => answer());
    await mount();
    await until(() => phase() === "error", "error phase");
    expect(status()).toBe(shown);
    // Never reached the SDK: no Device, no microphone prompt, nothing to leak.
    expect(voiceSdk.devices).toHaveLength(0);
    // Not "calling": no Hang up, and the bar does not close itself.
    expect(button("Hang up")).toBeNull();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(phase()).toBe("error");
    expect(onClose).not.toHaveBeenCalled();
    await click(button("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("BrowserCallBar — errors destroy the device", () => {
  it("a Device error while ringing shows the error and stays shown", async () => {
    const device = await mountToRinging();
    await emit(device, "error", { message: "AccessTokenInvalid (20101)" });
    expect(phase()).toBe("error");
    expect(status()).toBe("AccessTokenInvalid (20101)");
    expect(device.destroyCalls).toBe(1);
    expect(device.call.disconnectCalls).toBeGreaterThanOrEqual(1);
    // Destroying the Device made the call emit "disconnect": still an error,
    // and the bar does not auto-close over it.
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(phase()).toBe("error");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a call error mid-call shows the error and stops the clock", async () => {
    const device = await mountToInCall();
    await emit(device.call, "error", { message: "ConnectionError (31005)" });
    expect(phase()).toBe("error");
    expect(status()).toBe("ConnectionError (31005)");
    expect(device.destroyCalls).toBe(1);
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(status()).toBe("ConnectionError (31005)");
  });

  it("an error with no message still reads as a failure", async () => {
    const device = await mountToRinging();
    await emit(device, "error", undefined);
    expect(status()).toBe("Call failed.");
    expect(device.destroyCalls).toBe(1);
  });

  it("connect() rejecting (microphone refused) shows the error and destroys the device", async () => {
    voiceSdk.connect = () => Promise.reject(new Error("Permission denied"));
    await mount();
    await until(() => phase() === "error", "error phase");
    expect(status()).toBe("Permission denied");
    expect(voiceSdk.device.destroyCalls).toBe(1);
  });

  it("a Device error while connect() is still pending disconnects the call it later returns", async () => {
    let resolveConnect!: () => void;
    voiceSdk.connect = (device) => new Promise((resolve) => (resolveConnect = () => resolve(device.call)));
    await mount();
    await until(() => voiceSdk.devices.length === 1 && voiceSdk.device.connectOpts !== null, "connect called");
    const device = voiceSdk.device;
    await emit(device, "error", { message: "SignalingConnectionDisconnected" });
    expect(phase()).toBe("error");
    const before = device.call.disconnectCalls;
    resolveConnect();
    await act(async () => tick());
    expect(device.call.disconnectCalls).toBe(before + 1);
    await emit(device.call, "accept");
    expect(phase()).toBe("error");
  });
});

describe("BrowserCallBar — hanging up and unmounting", () => {
  it("Hang up mid-call ends it at once, without waiting for the SDK", async () => {
    const device = await mountToInCall();
    // An SDK that never reports the disconnect must not leave the bar in a call.
    device.call.disconnect = function (this: typeof device.call) {
      this.disconnectCalls++;
    };
    await click(button("Hang up"));
    expect(phase()).toBe("ended");
    expect(device.call.disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(device.destroyCalls).toBe(1);
    await act(async () => vi.advanceTimersByTime(2_500));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Hang up while the call is still being set up closes the bar", async () => {
    voiceSdk.connect = () => new Promise(() => {});
    await mount();
    await until(() => phase() === "ringing", "ringing");
    await click(button("Hang up"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unmounting mid-call disconnects the call and destroys the device", async () => {
    const device = await mountToInCall();
    await unmount();
    expect(device.call.disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(device.destroyCalls).toBe(1);
    // Nothing runs on after the unmount: no clock, no delayed close.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmounting ends the call itself, not only through destroy()", async () => {
    const device = await mountToInCall();
    // A Device whose destroy() left its call up would otherwise keep the line open.
    device.destroy = function (this: typeof device) {
      this.destroyCalls++;
    };
    await unmount();
    expect(device.destroyCalls).toBe(1);
    expect(device.call.disconnectCalls).toBe(1);
  });

  it("unmounting just after a call ended cancels the delayed close", async () => {
    const device = await mountToInCall();
    await emit(device.call, "disconnect");
    expect(phase()).toBe("ended");
    await unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmounting while ringing destroys the device", async () => {
    const device = await mountToRinging();
    await unmount();
    expect(device.destroyCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmounting while connect() is pending destroys the device and disconnects the late call", async () => {
    let resolveConnect!: () => void;
    voiceSdk.connect = (device) => new Promise((resolve) => (resolveConnect = () => resolve(device.call)));
    await mount();
    await until(() => voiceSdk.devices.length === 1 && voiceSdk.device.connectOpts !== null, "connect called");
    const device = voiceSdk.device;
    await unmount();
    expect(device.destroyCalls).toBe(1);
    const before = device.call.disconnectCalls;
    resolveConnect();
    await tick();
    await tick();
    expect(device.call.disconnectCalls).toBe(before + 1);
  });

  it("unmounting before the token arrives never constructs a device", async () => {
    let releaseToken!: () => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (releaseToken = () => resolve(tokenOk()))));
    await mount();
    await unmount();
    releaseToken();
    for (let i = 0; i < 20; i++) await tick();
    expect(voiceSdk.devices).toHaveLength(0);
  });
});

describe("BrowserCallBar — leaving the page while a call is live", () => {
  /** True when the page would ask before unloading. */
  function unloadPrompts() {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  }

  it("asks while ringing and in a call, and not before or after", async () => {
    let releaseToken!: () => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (releaseToken = () => resolve(tokenOk()))));
    await mount();
    expect(phase()).toBe("connecting");
    expect(unloadPrompts()).toBe(false);

    releaseToken();
    await until(() => phase() === "ringing", "ringing");
    await act(async () => tick());
    expect(unloadPrompts()).toBe(true);

    const device = voiceSdk.device;
    await emit(device.call, "accept");
    expect(unloadPrompts()).toBe(true);

    await emit(device.call, "disconnect");
    expect(phase()).toBe("ended");
    expect(unloadPrompts()).toBe(false);
  });

  it("stops asking after an error", async () => {
    const device = await mountToInCall();
    await emit(device.call, "error", { message: "ConnectionError (31005)" });
    expect(phase()).toBe("error");
    expect(unloadPrompts()).toBe(false);
  });

  it("stops asking once the bar unmounts mid-call", async () => {
    await mountToInCall();
    expect(unloadPrompts()).toBe(true);
    await unmount();
    expect(unloadPrompts()).toBe(false);
  });
});

describe("BrowserCallBar — an SDK that misbehaves", () => {
  it("a second accept does not start a second clock, and no interval outlives the bar", async () => {
    const device = await mountToRinging();
    await emit(device.call, "accept");
    await emit(device.call, "accept");
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(clock()).toBe(" · 0:03");
    await unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("call.disconnect() throwing on Hang up still ends the call and destroys the device", async () => {
    const warned: unknown[][] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warned.push(args));
    const device = await mountToInCall();
    const thrown = new Error("socket closed");
    device.call.disconnect = () => {
      throw thrown;
    };
    await click(button("Hang up"));
    expect(phase()).toBe("ended");
    expect(device.destroyCalls).toBe(1);
    // The message is logged, never the error object. (The fake's destroy()
    // disconnects its call again, so destroy reports the same throw.)
    expect(warned[0]).toEqual(["[dialer] call.disconnect failed:", "socket closed"]);
    expect(warned.flat().every((arg) => typeof arg === "string")).toBe(true);
  });

  it("device.destroy() throwing on an error still shows the error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const device = await mountToRinging();
    device.destroy = () => {
      throw new Error("already destroyed");
    };
    await emit(device, "error", { message: "AccessTokenInvalid (20101)" });
    expect(phase()).toBe("error");
    expect(status()).toBe("AccessTokenInvalid (20101)");
    expect(device.call.disconnectCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("BrowserCallBar — accessibility", () => {
  it("announces the status, and the toggles say what they are and whether they are on", async () => {
    const device = await mountToInCall();
    const line = container.querySelector('[data-testid="browser-call-status"]')!;
    expect(line.getAttribute("role")).toBe("status");
    expect(line.getAttribute("aria-live")).toBe("polite");

    const mute = container.querySelector<HTMLButtonElement>('button[aria-label="Mute"]')!;
    const keypad = container.querySelector<HTMLButtonElement>('button[aria-label="Keypad"]')!;
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(keypad.getAttribute("aria-expanded")).toBe("false");
    await click(mute);
    expect(device.call.muted).toBe(true);
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    // One name whichever state it is in; the state is aria-pressed.
    expect(mute.title).toBe("Mute");
    expect(mute.getAttribute("aria-label")).toBe("Mute");
    await click(keypad);
    expect(keypad.getAttribute("aria-expanded")).toBe("true");
  });

  it("the live region holds the phase, not the clock: it does not change as the call runs", async () => {
    await mountToInCall();
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(live.textContent).toBe("In call");
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(clock()).toBe(" · 0:05");
    expect(live.textContent).toBe("In call");
    expect(live.contains(container.querySelector('[data-testid="browser-call-clock"]'))).toBe(false);
  });
});
