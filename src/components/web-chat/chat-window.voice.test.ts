// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "@/components/web-chat/chat-window";

const sdk = vi.hoisted(() => ({
  loads: 0,
  startSession: vi.fn(),
}));

vi.mock("@elevenlabs/client", () => {
  sdk.loads += 1;
  return { Conversation: { startSession: sdk.startSession } };
});

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

  async function mount(query = "?vt=widget-token") {
    window.history.replaceState({}, "", `/${query}`);
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
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("hides the mic without the origin-checked widget token", async () => {
    await mount("");
    expect(micButton()).toBeNull();
    expect(sdk.startSession).not.toHaveBeenCalled();
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
    const loadsBefore = sdk.loads;
    await mount();
    await act(async () => micButton()?.click());
    await flush();

    expect(
      fetchMock.mock.calls.filter(
        ([url]) => String(url) === "/api/web-chat/voice/start"
      )
    ).toHaveLength(0);
    expect(sdk.loads).toBe(loadsBefore);
    expect(sdk.startSession).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Microphone access was blocked");
    expect(host.textContent).not.toContain("raw browser detail");
  });

  it("gets and releases microphone permission before start, then lazy-loads the SDK", async () => {
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
    sdk.startSession.mockImplementation(async (options: VoiceCallbacks) => {
      order.push("sdk");
      callbacks = options;
      return { endSession };
    });

    await mount();
    await act(async () => micButton()?.click());
    await flush();

    expect(order).toEqual(["permission", "probe-stopped", "start", "sdk"]);
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

    await mount("");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(host.textContent).not.toContain("duplicate spoken answer");
    expect(host.textContent).toContain("operator answer");
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

  it("cleans up retries and emits one ended event on end", async () => {
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
    ).toHaveLength(connectedBeforeEnd);
  });

  it("ends the SDK call and cancels claim retries on unmount", async () => {
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
    ).toHaveLength(connectedBeforeUnmount);
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

    await act(async () => {
      oldCallbacks?.onModeChange({ mode: "speaking" });
      oldCallbacks?.onMessage({
        message: "stale transcript",
        role: "agent",
        event_id: 9,
      });
      oldCallbacks?.onDisconnect();
    });

    expect(host.textContent).not.toContain("stale transcript");
    expect(host.textContent).toContain("Connecting");
  });
});
