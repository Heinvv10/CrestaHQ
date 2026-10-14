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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function toastText() {
  return [toast.error, toast.message, toast.success, toast.warning]
    .flatMap((mock) => mock.mock.calls.flat())
    .join(" ");
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
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load Web Voice settings. Try again."
    );
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
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load Web Voice settings. Try again."
    );
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
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load Web Voice settings. Try again."
    );
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
      "Couldn't disconnect ElevenLabs. Check your connection and try again."
    );
  });

  it("invalidates an in-flight sa1 mutation and clears its key before loading sa2", async () => {
    const oldMutation = deferred<Response>();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("/sa1/") && method === "GET") {
        return Promise.resolve(response({ meta: connectedMeta }));
      }
      if (url.includes("/sa1/") && method === "POST")
        return oldMutation.promise;
      if (url.includes("/sa2/") && method === "GET")
        return Promise.resolve(response());
      if (url.includes("/sa2/") && method === "POST") {
        return Promise.resolve(
          json({ meta: { ...connectedMeta, keyLast4: "2222" }, voices: [] })
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await render();

    await click(button("Replace key"));
    const oldKey = "sk_old_tenant_secret_123456";
    const replacement = container.querySelector<HTMLInputElement>(
      '[aria-label="New ElevenLabs API key"]'
    )!;
    await changeValue(replacement, oldKey);
    await submit(replacement.form!);

    ctx.value = { ...ctx.value, subAccountId: "sa2" };
    await render();
    expect(container.querySelector<HTMLInputElement>("#wv-key")!.value).toBe(
      ""
    );
    expect(container.textContent).not.toContain("…abcd");

    await act(async () => {
      oldMutation.resolve(
        json({
          meta: { ...connectedMeta, keyLast4: "old1", lastError: oldKey },
          voices: [],
        })
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Connect ElevenLabs");
    expect(container.textContent).not.toContain("old1");
    expect(toastText()).not.toContain(oldKey);
    expect(toast.success).not.toHaveBeenCalled();

    const newKey = "sk_new_tenant_secret_654321";
    const input = container.querySelector<HTMLInputElement>("#wv-key")!;
    await changeValue(input, newKey);
    await submit(input.form!);

    const posts = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST"
    );
    expect(posts).toHaveLength(2);
    expect(posts[1]?.[0]).toContain("/sa2/web-voice");
    expect(JSON.parse(String(posts[1]?.[1]?.body))).toEqual({ apiKey: newKey });
    expect(String(posts[1]?.[1]?.body)).not.toContain(oldKey);
  });

  it("aborts an old tenant load and ignores its out-of-order response", async () => {
    const oldLoad = deferred<Response>();
    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      url.includes("/sa1/") ? oldLoad.promise : Promise.resolve(response())
    );
    vi.stubGlobal("fetch", fetchMock);
    await render();

    ctx.value = { ...ctx.value, subAccountId: "sa2" };
    await render();

    const oldSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)
      ?.signal;
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => {
      oldLoad.resolve(response({ meta: connectedMeta }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Connect ElevenLabs");
    expect(container.textContent).not.toContain("…abcd");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("redacts provider status errors from the card", async () => {
    const malicious = "<script>provider-secret-stack</script>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          meta: { ...connectedMeta, ready: false, lastError: malicious },
          voicesError: malicious,
        })
      )
    );

    await render();

    expect(container.textContent).toContain(
      "The ElevenLabs voice agent isn't ready"
    );
    expect(container.textContent).toContain(
      "Couldn't load your ElevenLabs voices"
    );
    expect(container.textContent).not.toContain(malicious);
    expect(toastText()).not.toContain(malicious);
  });

  it("redacts a POST server error and clears the submitted API key", async () => {
    const apiKey = "sk_submitted_secret_123456789";
    const malicious = `Provider rejected ${apiKey} with stack trace`;
    fetchSequence(response(), json({ error: malicious }, 502));
    await render();

    const input = container.querySelector<HTMLInputElement>("#wv-key")!;
    await changeValue(input, apiKey);
    await submit(input.form!);

    expect(input.value).toBe("");
    expect(container.textContent).not.toContain(apiKey);
    expect(container.textContent).not.toContain(malicious);
    expect(toastText()).not.toContain(apiKey);
    expect(toastText()).not.toContain(malicious);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't connect ElevenLabs. Check the key and try again."
    );
  });

  it("uses fixed feedback for a direct POST network failure", async () => {
    const apiKey = "sk_network_secret_123456789";
    fetchSequence(response(), new Error(`socket exposed ${apiKey}`));
    await render();

    const input = container.querySelector<HTMLInputElement>("#wv-key")!;
    await changeValue(input, apiKey);
    await submit(input.form!);

    expect(input.value).toBe("");
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't connect ElevenLabs. Check your connection and try again."
    );
    expect(toastText()).not.toContain(apiKey);
    expect(toastText()).not.toContain("socket exposed");
  });

  it("uses fixed feedback for a direct PATCH network failure", async () => {
    fetchSequence(
      response({ meta: connectedMeta }),
      new Error("provider stack and credential")
    );
    await render();

    await submit(button("Save voice settings").form!);

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save voice settings. Check your connection and try again."
    );
    expect(toastText()).not.toContain("provider stack");
  });

  it("uses fixed feedback when the initial GET rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("raw sdk headers")))
    );

    await render();

    expect(container.textContent).toContain("Couldn't load Web Voice settings");
    expect(container.textContent).not.toContain("raw sdk headers");
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load Web Voice settings. Try again."
    );
    expect(toastText()).not.toContain("raw sdk headers");
  });
});
