// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebVoiceMeta } from "@/types/web-voice";

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    isAdmin: true,
  },
}));

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ctx.value,
}));
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast,
}));

const { WebVoiceSection } = await import("./web-voice-section");

interface StatusResponse {
  gateOn: boolean;
  webChatGateOn: boolean;
  meta: WebVoiceMeta | null;
  usage: {
    secondsToday: number;
    secondsThisMonth: number;
    activeNow: number;
  } | null;
  voices: Array<{
    voiceId: string;
    name: string;
    category: string | null;
    description: string | null;
    previewUrl: string | null;
  }>;
  voicesError: string | null;
  previewToken: string | null;
}

const status: StatusResponse = {
  gateOn: true,
  webChatGateOn: true,
  meta: null,
  usage: null,
  voices: [],
  voicesError: null,
  previewToken: null,
};

const connectedMeta: WebVoiceMeta = {
  enabled: true,
  voiceId: "voice-1",
  voiceName: "Alice",
  language: "en",
  greeting: "Hello",
  maxCallSeconds: 300,
  dailyMinuteCap: 60,
  ready: true,
  keyLast4: "abcd",
  lastError: null,
  connectedAt: null,
};

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () => {
    root.render(createElement(WebVoiceSection));
  });
}

function response(overrides: Partial<StatusResponse> = {}) {
  return new Response(JSON.stringify({ ...status, ...overrides }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function json(body: unknown, statusCode = 200) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}

function fetchSequence(...results: Array<Response | Error>) {
  const fetchMock = vi.fn();
  for (const result of results) {
    if (result instanceof Error) fetchMock.mockRejectedValueOnce(result);
    else fetchMock.mockResolvedValueOnce(result);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function changeValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  });
}

function button(text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ctx.value = { subAccountId: "sa1", isAdmin: true };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("WebVoiceSection guards", () => {
  it("renders nothing and does not fetch for a non-admin", async () => {
    ctx.value = { ...ctx.value, isAdmin: false };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await render();

    expect(container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders nothing when Web Chat is locked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ webChatGateOn: false }))
    );

    await render();

    expect(container.textContent).toBe("");
  });

  it("shows the locked card when the Web Voice gate is off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ gateOn: false }))
    );

    await render();

    expect(container.textContent).toContain(
      "Talking to the chat widget is locked"
    );
    expect(container.textContent).toContain("enable Web Voice");
    expect(container.textContent).not.toContain("ElevenLabs API key");
  });

  it("shows the connection form when both gates are on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response())
    );

    await render();

    expect(container.textContent).toContain("Voice (ElevenLabs)");
    expect(container.textContent).toContain("ElevenLabs API key");
    expect(container.textContent).not.toContain(
      "Talking to the chat widget is locked"
    );
  });
});

describe("WebVoiceSection mutations", () => {
  it("keeps the connected POST result when the refresh fails", async () => {
    const fetchMock = fetchSequence(
      response(),
      json({ meta: connectedMeta, voices: [] }),
      new Error("refresh failed")
    );
    await render();

    const input = container.querySelector<HTMLInputElement>("#wv-key")!;
    await changeValue(input, "sk_test_key_1234567890");
    await submit(input.form!);

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(container.textContent).toContain("Key ending …abcd");
    expect(container.textContent).toContain("Save voice settings");
    expect(container.textContent).not.toContain("Connect ElevenLabs");
    expect(toast.success).toHaveBeenCalledWith(
      "ElevenLabs connected — voice is ready"
    );
    expect(toast.error).toHaveBeenCalledWith("refresh failed");
  });

  it("keeps the saved PATCH result when the refresh fails", async () => {
    const saved = { ...connectedMeta, greeting: "Canonical greeting" };
    const fetchMock = fetchSequence(
      response({ meta: connectedMeta }),
      json({ meta: saved }),
      new Error("refresh failed")
    );
    await render();

    const greeting =
      container.querySelector<HTMLTextAreaElement>("#wv-greeting")!;
    await changeValue(greeting, "  Canonical greeting  ");
    await submit(button("Save voice settings").form!);

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH" });
    expect(
      container.querySelector<HTMLTextAreaElement>("#wv-greeting")!.value
    ).toBe(saved.greeting);
    expect(container.textContent).toContain("Key ending …abcd");
    expect(toast.success).toHaveBeenCalledWith("Voice settings saved");
    expect(toast.error).toHaveBeenCalledWith("refresh failed");
  });

  it("clears the connected DELETE state when the refresh fails", async () => {
    const fetchMock = fetchSequence(
      response({ meta: connectedMeta }),
      json({ ok: true }),
      new Error("refresh failed")
    );
    await render();

    await click(button("Disconnect"));
    await click(button("Confirm disconnect"));

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(container.textContent).toContain("Connect ElevenLabs");
    expect(container.textContent).not.toContain("Key ending …abcd");
    expect(toast.success).toHaveBeenCalledWith(
      "ElevenLabs disconnected — the mic is gone from the widget"
    );
    expect(toast.error).toHaveBeenCalledWith("refresh failed");
  });

  it("reports a DELETE network failure and retains the connected state", async () => {
    fetchSequence(response({ meta: connectedMeta }), new Error("offline"));
    await render();

    await click(button("Disconnect"));
    await click(button("Confirm disconnect"));

    expect(container.textContent).toContain("Key ending …abcd");
    expect(container.textContent).not.toContain("Connect ElevenLabs");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Network error — couldn't disconnect. Try again."
    );
  });
});
