// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    isAdmin: true,
  },
}));

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ctx.value,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

const { WebVoiceSection } = await import("./web-voice-section");

interface StatusResponse {
  gateOn: boolean;
  webChatGateOn: boolean;
  meta: null;
  usage: null;
  voices: never[];
  voicesError: null;
  previewToken: null;
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

beforeEach(() => {
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
