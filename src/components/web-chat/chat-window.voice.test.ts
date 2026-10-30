// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "@/components/web-chat/chat-window";

const sdk = vi.hoisted(() => ({
  load: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock("@/components/web-chat/voice-sdk", () => ({
  loadVoiceClient: sdk.load,
}));

type VoiceCallbacks = {
  onConnect: (event: { conversationId: string }) => void;
  onDisconnect: () => void;
  onError: (message: string) => void;
  onModeChange: (event: { mode: "speaking" | "listening" }) => void;
  onMessage: (event: {
    message: string;
    role: "user" | "agent";
    event_id: number;
  }) => void;
};

const jsonResponse = (body: object, ok = true) =>
  ({ ok, json: async () => body }) as Response;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ChatWindow Web Voice", () => {
  let root: Root;
  let host: HTMLDivElement;
  let callbacks: VoiceCallbacks | null;
  let endSession: ReturnType<typeof vi.fn>;
  let trackStop: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function mount(url = "/#vt=widget-token") {
    window.history.replaceState({}, "", url);
    await act(async () => {
      root.render(
        createElement(ChatWindow, {
          subAccountId: "sa1",
          welcomeMessage: "Hello",
          accentColor: "#2563eb",
          embedded: true,
        })
      );
    });
    await flush();
  }

  function micButton() {
    return host.querySelector<HTMLButtonElement>(
      'button[aria-label="Talk to us (voice)"]'
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    callbacks = null;
    endSession = vi.fn().mockResolvedValue(undefined);
    trackStop = vi.fn();
    sdk.startSession
      .mockReset()
      .mockImplementation(async (options: VoiceCallbacks) => {
        callbacks = options;
        return { endSession };
      });
    sdk.load
      .mockReset()
      .mockResolvedValue({ Conversation: { startSession: sdk.startSession } });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi
          .fn()
          .mockResolvedValue({ getTracks: () => [{ stop: trackStop }] }),
      },
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/web-chat/poll")) {
        return jsonResponse({ messages: [] });
      }
      if (url === "/api/web-chat/voice/start") {
        return jsonResponse({
          signedUrl: "wss://voice.example.test/signed",
          token: "session-token",
          maxCallSeconds: 300,
        });
      }
      if (url === "/api/web-chat/voice/event") {
        return jsonResponse({ ok: true, claimed: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    localStorage.clear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: window,
    });
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("hides the mic without the origin-checked widget token", async () => {
    await mount("/");
    expect(micButton()).toBeNull();
    expect(sdk.load).not.toHaveBeenCalled();
    expect(sdk.startSession).not.toHaveBeenCalled();
  });

  it("captures the settings-preview token from the fragment and scrubs it immediately", async () => {
    await mount("/embed/chat/sa1?preview=1#keep=yes&vt=fragment-secret");

    expect(window.location.search).toBe("?preview=1");
    expect(window.location.hash).toBe("#keep=yes");
    expect(window.location.href).not.toContain("fragment-secret");
    expect(document.referrer).not.toContain("fragment-secret");
    expect(sdk.load).toHaveBeenCalledTimes(1);
    expect(micButton()).toBeTruthy();
    expect(micButton()?.disabled).toBe(false);
  });

  it("preloads before the gesture and never starts when SDK preload fails", async () => {
    sdk.load.mockRejectedValueOnce(new Error("raw sdk preload failure"));
    await mount();

    expect(sdk.load).toHaveBeenCalledTimes(1);
    expect(micButton()?.disabled).toBe(true);
    await act(async () => micButton()?.click());
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/api/web-chat/voice/start"),
      ),
    ).toHaveLength(0);
    expect(host.textContent).toContain("Voice couldn't load");
    expect(host.textContent).not.toContain("raw sdk preload failure");
  });

  it("accepts token and host-close only from the validated parent channel", async () => {
    const parentFrame = document.createElement("iframe");
    document.body.appendChild(parentFrame);
    const fakeParent = parentFrame.contentWindow!;
    const parentPost = vi.spyOn(fakeParent, "postMessage").mockImplementation(() => {});
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: fakeParent,
    });
    await mount(`/?p=${encodeURIComponent("https://shop.example/page")}`);

    expect(parentPost).toHaveBeenCalledWith(
      { source: "leadstack-webchat", type: "ready" },
      "https://shop.example",
    );
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: fakeParent,
          origin: "https://shop.example",
          data: {
            source: "leadstack-webchat-host",
            type: "voice-token",
            token: "handshake-token",
          },
        }),
      ),
    );
    await flush();
    expect(micButton()?.disabled).toBe(false);
    await act(async () => micButton()?.click());
    await flush();
    await act(async () => callbacks?.onConnect({ conversationId: "conv-host" }));
    await flush();

    const hostClose = {
      source: "leadstack-webchat-host",
      type: "host-close",
    };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: fakeParent,
          origin: "https://evil.example",
          data: hostClose,
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          source: null,
          origin: "https://shop.example",
          data: hostClose,
        }),
      );
    });
    expect(endSession).not.toHaveBeenCalled();

    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: fakeParent,
          origin: "https://shop.example",
          data: hostClose,
        }),
      ),
    );
    expect(endSession).toHaveBeenCalledTimes(1);
    parentFrame.remove();
  });

  it("does not reserve a call or load the SDK when microphone permission fails", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(new Error("raw browser detail")),
      },
    });
    await mount();
    await act(async () => micButton()?.click());
    await flush();

    expect(
      fetchMock.mock.calls.filter(
        ([url]) => String(url) === "/api/web-chat/voice/start"
      )
    ).toHaveLength(0);
    expect(sdk.load).toHaveBeenCalledTimes(1);
    expect(sdk.startSession).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Microphone access was blocked");
    expect(host.textContent).not.toContain("raw browser detail");
  });

  it("preloads the SDK, then gets and releases microphone permission before start", async () => {
    const order: string[] = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          order.push("permission");
          return {
            getTracks: () => [{ stop: () => order.push("probe-stopped") }],
          };
        }),
      },
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/web-chat/poll"))
        return jsonResponse({ messages: [] });
      if (url === "/api/web-chat/voice/start") {
        order.push("start");
        return jsonResponse({
          signedUrl: "wss://signed",
          token: "session-token",
        });
      }
      return jsonResponse({ ok: true, claimed: false });
    });
    sdk.load.mockImplementation(async () => {
      order.push("sdk-loaded");
      return { Conversation: { startSession: sdk.startSession } };
    });
    sdk.startSession.mockImplementation(async (options: VoiceCallbacks) => {
      order.push("sdk");
      callbacks = options;
      return { endSession };
    });

    await mount();
    await act(async () => micButton()?.click());
    await flush();

    expect(order).toEqual([
      "sdk-loaded",
      "permission",
      "probe-stopped",
      "start",
      "sdk",
    ]);
  });

  it("bounds connected reporting to four attempts over about 30 seconds", async () => {
    await mount();
    await act(async () => micButton()?.click());
    await flush();
    await act(async () => callbacks?.onConnect({ conversationId: "conv-1" }));
    await act(async () => callbacks?.onConnect({ conversationId: "late-conv" }));
    await flush();

    const connectedCalls = () =>
      fetchMock.mock.calls.filter(
        ([, init]) =>
          typeof init?.body === "string" &&
          init.body.includes('"type":"connected"')
      );
    expect(connectedCalls()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(connectedCalls()).toHaveLength(4);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(connectedCalls()).toHaveLength(4);
  });

  it("does not duplicate voice turns returned by the delivery poll", async () => {
    let polls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/web-chat/poll")) {
        polls += 1;
        return jsonResponse({
          messages:
            polls === 1
              ? []
              : [
                  {
                    id: "voice-row",
                    body: "duplicate spoken answer",
                    via: "voice",
                    createdAtMs: 2,
                  },
                  { id: "typed-row", body: "operator answer", createdAtMs: 3 },
                ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await mount("/");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(host.textContent).not.toContain("duplicate spoken answer");
    expect(host.textContent).toContain("operator answer");
  });

  it("deduplicates only valid current-call SDK event ids after validating text", async () => {
    await mount();
    await act(async () => micButton()?.click());
    await flush();
    await act(async () => {
      callbacks?.onMessage({ message: "", role: "agent", event_id: 7 });
      callbacks?.onMessage({ message: "One answer", role: "agent", event_id: 7 });
      callbacks?.onMessage({ message: "Duplicate answer", role: "agent", event_id: 7 });
      callbacks?.onMessage({
        message: "No id one",
        role: "agent",
        event_id: undefined as unknown as number,
      });
      callbacks?.onMessage({
        message: "No id two",
        role: "agent",
        event_id: undefined as unknown as number,
      });
      callbacks?.onMessage({
        message: "Invalid id one",
        role: "agent",
        event_id: "   " as unknown as number,
      });
      callbacks?.onMessage({
        message: "Invalid id two",
        role: "agent",
        event_id: Number.NaN,
      });
    });

    expect(host.textContent).toContain("One answer");
    expect(host.textContent).not.toContain("Duplicate answer");
    expect(host.textContent).toContain("No id one");
    expect(host.textContent).toContain("No id two");
    expect(host.textContent).toContain("Invalid id one");
    expect(host.textContent).toContain("Invalid id two");
  });

  it("stops connected retries immediately when the server confirms the claim", async () => {
    let connected = 0;
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/web-chat/poll"))
          return jsonResponse({ messages: [] });
        if (url === "/api/web-chat/voice/start") {
          return jsonResponse({
            signedUrl: "wss://signed",
            token: "session-token",
          });
        }
        if (
          typeof init?.body === "string" &&
          init.body.includes('"type":"connected"')
        ) {
          connected += 1;
          return jsonResponse({ ok: true, claimed: connected === 2 });
        }
        return jsonResponse({ ok: true });
      }
    );

    await mount();
    await act(async () => micButton()?.click());
    await flush();
    await act(async () =>
      callbacks?.onConnect({ conversationId: "conv-claim" })
    );
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(connected).toBe(2);
  });

  it("keeps failed settlement retries bounded after end", async () => {
    await mount();
    await act(async () => micButton()?.click());
    await flush();
    await act(async () => callbacks?.onConnect({ conversationId: "conv-end" }));
    await flush();
    const connectedBeforeEnd = fetchMock.mock.calls.filter(
      ([, init]) =>
        typeof init?.body === "string" &&
        init.body.includes('"type":"connected"')
    ).length;

    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="End voice chat"]')
        ?.click()
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(endSession).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) =>
          typeof init?.body === "string" && init.body.includes('"type":"ended"')
      )
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) =>
          typeof init?.body === "string" &&
          init.body.includes('"type":"connected"')
      )
    ).toHaveLength(4);
    expect(connectedBeforeEnd).toBe(1);
  });

  it("ends the SDK call and bounds settlement retries on unmount", async () => {
    await mount();
    await act(async () => micButton()?.click());
    await flush();
    await act(async () =>
      callbacks?.onConnect({ conversationId: "conv-unmount" })
    );
    await flush();
    const connectedBeforeUnmount = fetchMock.mock.calls.filter(
      ([, init]) =>
        typeof init?.body === "string" &&
        init.body.includes('"type":"connected"')
    ).length;

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(endSession).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) =>
          typeof init?.body === "string" && init.body.includes('"type":"ended"')
      )
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) =>
          typeof init?.body === "string" &&
          init.body.includes('"type":"connected"')
      )
    ).toHaveLength(4);
    expect(connectedBeforeUnmount).toBe(1);
  });

  it("follows a late successful claim with exactly one more ended event", async () => {
    const firstClaim = deferred<Response>();
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/web-chat/poll"))
          return jsonResponse({ messages: [] });
        if (url === "/api/web-chat/voice/start") {
          return jsonResponse({ signedUrl: "wss://signed", token: "session-token" });
        }
        if (
          typeof init?.body === "string" &&
          init.body.includes('"type":"connected"')
        ) {
          return firstClaim.promise;
        }
        return jsonResponse({ ok: true });
      },
    );

    await mount();
    await act(async () => micButton()?.click());
    await flush();
    await act(async () => callbacks?.onConnect({ conversationId: "conv-late" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="End voice chat"]')
        ?.click(),
    );

    const endedCalls = () =>
      fetchMock.mock.calls.filter(
        ([, init]) =>
          typeof init?.body === "string" && init.body.includes('"type":"ended"'),
      );
    expect(endedCalls()).toHaveLength(1);
    await act(async () => micButton()?.click());
    await flush();
    expect(sdk.startSession).toHaveBeenCalledTimes(2);

    firstClaim.resolve(jsonResponse({ ok: true, claimed: true }));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(endedCalls()).toHaveLength(2);
    expect(host.textContent).toContain("Connecting");
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) =>
          typeof init?.body === "string" && init.body.includes('"type":"connected"'),
      ),
    ).toHaveLength(2);
  });

  it("retries a failed in-flight claim after end and settles its later claim", async () => {
    const firstClaim = deferred<Response>();
    let connected = 0;
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/web-chat/poll"))
          return jsonResponse({ messages: [] });
        if (url === "/api/web-chat/voice/start") {
          return jsonResponse({ signedUrl: "wss://signed", token: "session-token" });
        }
        if (
          typeof init?.body === "string" &&
          init.body.includes('"type":"connected"')
        ) {
          connected += 1;
          return connected === 1
            ? firstClaim.promise
            : jsonResponse({ ok: true, claimed: true });
        }
        return jsonResponse({ ok: true });
      },
    );

    await mount();
    await act(async () => micButton()?.click());
    await flush();
    await act(async () => callbacks?.onConnect({ conversationId: "conv-retry" }));
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="End voice chat"]')
        ?.click(),
    );
    firstClaim.resolve(jsonResponse({ ok: false }, false));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(connected).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) =>
          typeof init?.body === "string" && init.body.includes('"type":"ended"'),
      ),
    ).toHaveLength(2);
  });

  it("falls back when sendBeacon declines the end and still emits it once", async () => {
    const sendBeacon = vi.fn(() => false);
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    await mount();
    await act(async () => micButton()?.click());
    await flush();
    const activeCallbacks = callbacks;
    await act(async () => activeCallbacks?.onConnect({ conversationId: "conv-beacon" }));
    await flush();

    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await act(async () => activeCallbacks?.onDisconnect());

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.filter(([, init]) =>
        typeof init?.body === "string" && init.body.includes('"type":"ended"'),
      ),
    ).toHaveLength(1);
  });

  it("restores idle controls after a persisted pagehide and pageshow", async () => {
    await mount();
    await act(async () => micButton()?.click());
    await flush();
    await act(async () => callbacks?.onConnect({ conversationId: "conv-bfcache" }));
    await flush();

    const pagehide = new Event("pagehide");
    Object.defineProperty(pagehide, "persisted", { value: true });
    const pageshow = new Event("pageshow");
    Object.defineProperty(pageshow, "persisted", { value: true });
    await act(async () => {
      window.dispatchEvent(pagehide);
      window.dispatchEvent(pageshow);
    });

    expect(endSession).toHaveBeenCalledTimes(1);
    expect(
      host.querySelector('button[aria-label="End voice chat"]'),
    ).toBeNull();
    expect(micButton()).toBeTruthy();
    expect(micButton()?.disabled).toBe(false);
    await act(async () => micButton()?.click());
    await flush();
    expect(sdk.startSession).toHaveBeenCalledTimes(2);
  });

  it("never renders raw SDK error text", async () => {
    await mount();
    await act(async () => micButton()?.click());
    await flush();
    await act(async () =>
      callbacks?.onError("provider secret and websocket detail")
    );

    expect(host.textContent).toContain("Voice connection problem");
    expect(host.textContent).not.toContain("provider secret");
    expect(host.textContent).not.toContain("websocket detail");
  });

  it("ignores late callbacks from an ended call after a newer call starts", async () => {
    await mount();
    await act(async () => micButton()?.click());
    await flush();
    const oldCallbacks = callbacks;
    await act(async () =>
      oldCallbacks?.onConnect({ conversationId: "conv-old" })
    );
    await flush();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="End voice chat"]')
        ?.click()
    );
    await flush();
    await act(async () => micButton()?.click());
    await flush();
    const newCallbacks = callbacks;

    await act(async () => {
      oldCallbacks?.onModeChange({ mode: "speaking" });
      oldCallbacks?.onMessage({
        message: "stale transcript",
        role: "agent",
        event_id: 9,
      });
      oldCallbacks?.onDisconnect();
      newCallbacks?.onMessage({
        message: "fresh transcript",
        role: "agent",
        event_id: 9,
      });
    });

    expect(host.textContent).not.toContain("stale transcript");
    expect(host.textContent).toContain("fresh transcript");
    expect(host.textContent).toContain("Connecting");
  });
});
