// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "@/components/web-chat/chat-window";

/**
 * The inline capture form is reached the way a visitor reaches it: send a
 * message, the server replies with formFields, the form renders under the
 * reply. Its "Send details" button sits on the accent colour.
 */

let root: Root;
let host: HTMLDivElement;

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function openCaptureForm(accentColor: string): Promise<HTMLButtonElement> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        String(url).includes("/message") ? { reply: "Can I get your name?", formFields: ["name"], messageId: "m1" } : { messages: [] },
    })),
  );
  await act(async () => {
    root.render(createElement(ChatWindow, { subAccountId: "sa1", welcomeMessage: "hi", accentColor, embedded: false }));
  });
  await tick();
  const input = host.querySelector<HTMLInputElement>('input[placeholder="Type a message…"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "hello");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await tick();
  const btn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Send details"));
  if (!btn) throw new Error("capture form not rendered");
  return btn;
}

/** jsdom normalises colours to rgb(); normalise the expectation the same way. */
const rgb = (c: string) => {
  const el = document.createElement("div");
  el.style.color = c;
  return el.style.color;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("InlineCaptureForm submit button text on accent", () => {
  it("light accent gets dark text", async () => {
    expect((await openCaptureForm("#facc15")).style.color).toBe(rgb("#0f172a"));
  });
  it("dark accent keeps white text", async () => {
    expect((await openCaptureForm("#1e3a8a")).style.color).toBe(rgb("#ffffff"));
  });
});
