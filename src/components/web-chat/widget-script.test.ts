// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textOnAccent } from "@/components/web-chat/contrast";

/**
 * public/widget.js runs for real in jsdom against a stubbed config fetch.
 * Its inlined textOnAccent must agree with contrast.ts for the launcher bubble.
 */
const SCRIPT = readFileSync(join(process.cwd(), "public/widget.js"), "utf8");

async function bubbleColour(accentColor: string): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({
        json: async () => ({ enabled: true, accentColor, position: "right" }),
      })
  );
  const tag = document.createElement("script");
  tag.src = "https://crm.example.test/widget.js";
  tag.setAttribute("data-sa", "sa_1");
  document.body.appendChild(tag);
  Object.defineProperty(document, "currentScript", {
    value: tag,
    configurable: true,
  });
  new Function(SCRIPT)();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const bubble = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Open chat"]'
  );
  if (!bubble) throw new Error("bubble not mounted");
  return bubble.style.color;
}

/** jsdom normalises colours to rgb(); normalise the expected value the same way. */
const normalised = (c: string) => {
  const el = document.createElement("div");
  el.style.color = c;
  return el.style.color;
};

beforeEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>)
    .__leadstackWebChatLoaded;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public/widget.js launcher bubble", () => {
  it.each([
    "#facc15",
    "#ffff00",
    "#fde68a",
    "#1e3a8a",
    "#2563eb",
    "#000",
    "#fff",
    "#808080",
    "#707070",
    "nonsense",
  ])(
    "bubble text colour for %s matches contrast.ts textOnAccent",
    async (accent) => {
      expect(await bubbleColour(accent)).toBe(normalised(textOnAccent(accent)));
    }
  );

  it("keeps the token out of the iframe URL and sends it only after a verified ready message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          enabled: true,
          accentColor: "#2563eb",
          position: "right",
          voiceEnabled: true,
          voiceToken: "w1.origin-checked",
        }),
      })
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const tag = document.createElement("script");
    tag.src = "https://crm.example.test/widget.js";
    tag.setAttribute("data-sa", "sa_1");
    document.body.appendChild(tag);
    Object.defineProperty(document, "currentScript", {
      value: tag,
      configurable: true,
    });
    new Function(SCRIPT)();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    document
      .querySelector<HTMLButtonElement>('button[aria-label="Open chat"]')
      ?.click();
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[title="Chat with us"]'
    );
    expect(iframe?.allow).toBe("clipboard-write; microphone");
    expect(iframe?.src).not.toContain("w1.origin-checked");
    expect(new URL(iframe?.src ?? "https://invalid.test").searchParams.has("vt"))
      .toBe(false);
    expect(new URL(iframe?.src ?? "https://invalid.test").hash).toBe("");

    const childPost = vi
      .spyOn(iframe!.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe!.contentWindow,
        origin: "https://crm.example.test",
        data: { source: "leadstack-webchat", type: "ready" },
      })
    );
    expect(childPost).toHaveBeenCalledWith(
      {
        source: "leadstack-webchat-host",
        type: "voice-token",
        token: "w1.origin-checked",
      },
      "https://crm.example.test"
    );
  });

  it("does not pass a token when the config returns the gate-off shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          enabled: true,
          accentColor: "#2563eb",
          position: "right",
          voiceEnabled: false,
        }),
      })
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const tag = document.createElement("script");
    tag.src = "https://crm.example.test/widget.js";
    tag.setAttribute("data-sa", "sa_1");
    document.body.appendChild(tag);
    Object.defineProperty(document, "currentScript", {
      value: tag,
      configurable: true,
    });
    new Function(SCRIPT)();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    document
      .querySelector<HTMLButtonElement>('button[aria-label="Open chat"]')
      ?.click();
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[title="Chat with us"]'
    );
    expect(
      new URL(iframe?.src ?? "https://invalid.test").searchParams.has("vt")
    ).toBe(false);
  });

  it("notifies the exact iframe before launcher X hides a live call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          enabled: true,
          accentColor: "#2563eb",
          position: "right",
          voiceEnabled: true,
          voiceToken: "in-memory-only",
        }),
      })
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const tag = document.createElement("script");
    tag.src = "https://crm.example.test/widget.js";
    tag.setAttribute("data-sa", "sa_1");
    document.body.appendChild(tag);
    Object.defineProperty(document, "currentScript", {
      value: tag,
      configurable: true,
    });
    new Function(SCRIPT)();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    document.querySelector<HTMLButtonElement>('button[aria-label="Open chat"]')?.click();
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Chat with us"]')!;
    const childPost = vi
      .spyOn(iframe.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    document.querySelector<HTMLButtonElement>('button[aria-label="Close chat"]')?.click();

    expect(childPost).toHaveBeenCalledWith(
      { source: "leadstack-webchat-host", type: "host-close" },
      "https://crm.example.test"
    );
    expect(document.querySelector('button[aria-label="Open chat"]')).toBeTruthy();
  });

  it("ignores spoofed iframe messages and accepts only the exact child source and origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ enabled: true, accentColor: "#2563eb", position: "right" }),
      })
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const tag = document.createElement("script");
    tag.src = "https://crm.example.test/widget.js";
    tag.setAttribute("data-sa", "sa_1");
    document.body.appendChild(tag);
    Object.defineProperty(document, "currentScript", {
      value: tag,
      configurable: true,
    });
    new Function(SCRIPT)();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    document.querySelector<HTMLButtonElement>('button[aria-label="Open chat"]')?.click();
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Chat with us"]')!;
    const close = { source: "leadstack-webchat", type: "close" };

    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "https://evil.example",
        data: close,
      })
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: null,
        origin: "https://crm.example.test",
        data: close,
      })
    );
    expect(document.querySelector('button[aria-label="Close chat"]')).toBeTruthy();

    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "https://crm.example.test",
        data: close,
      })
    );
    expect(document.querySelector('button[aria-label="Open chat"]')).toBeTruthy();
  });
});
