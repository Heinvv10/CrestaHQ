// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceSdk } from "@/test/fake-voice-sdk";
import type { Contact } from "@/types/contacts";

/**
 * Unmounting the call bar at the two awaits before a Device exists: while the
 * token is outstanding, and while the Voice SDK module is still loading. In
 * both, nothing may be constructed afterwards — a Device built after the bar
 * is gone would never be destroyed, and would place a call nobody can see.
 *
 * The mock holds the SDK's load behind a gate. Each test re-registers it with
 * a fresh gate, so each test's first import() loads it afresh.
 */

const sdk = { requested: 0, gate: Promise.resolve(), open: () => {} };
function gatedSdkMock() {
  sdk.requested = 0;
  sdk.gate = new Promise<void>((resolve) => (sdk.open = resolve));
  vi.doMock("@twilio/voice-sdk", async () => {
    sdk.requested++;
    await sdk.gate;
    return (await import("@/test/fake-voice-sdk")).fakeVoiceSdkModule();
  });
}

const { BrowserCallBar } = await import("./browser-call-bar");

const contact = { id: "c1", name: "Thandi Mokoena", phone: "+27821234567" } as Contact;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const tokenOk = () => new Response(JSON.stringify({ ok: true, token: "eyJ.fake.sig" }), { status: 200 });

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

async function mount() {
  await act(async () => {
    root.render(createElement(BrowserCallBar, { contact, subAccountId: "sa1", onClose: () => {} }));
  });
}
async function settle() {
  for (let i = 0; i < 30; i++) await act(async () => tick());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voiceSdk.reset();
  gatedSdkMock();
  fetchMock = vi.fn(async () => tokenOk());
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

describe("BrowserCallBar — unmounting before a Device exists", () => {
  it("while the token is outstanding: the SDK is never even loaded", async () => {
    let releaseToken!: () => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (releaseToken = () => resolve(tokenOk()))));
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    releaseToken();
    await settle();
    expect(sdk.requested).toBe(0);
    expect(voiceSdk.devices).toHaveLength(0);
  });

  it("while the SDK is loading: no Device is constructed once it arrives", async () => {
    await mount();
    for (let i = 0; i < 200 && sdk.requested === 0; i++) await act(async () => tick());
    expect(sdk.requested).toBe(1);
    expect(voiceSdk.loads).toBe(0);
    await act(async () => root.unmount());
    sdk.open();
    await settle();
    expect(voiceSdk.loads).toBe(1);
    expect(voiceSdk.devices).toHaveLength(0);
  });
});
