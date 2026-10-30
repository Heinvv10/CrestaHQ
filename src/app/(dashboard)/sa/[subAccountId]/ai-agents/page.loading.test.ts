// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The channel cards and the SMS nag read the workspace doc, which is null
 * while it loads. When the channel fetches finish first, the page must not
 * claim SMS is "Not configured" or nag "Set up SMS first" until it knows.
 */

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    subAccount: null as Record<string, unknown> | null,
    saPath: (p: string) => `/sa/sa1${p}`,
    loading: true,
  },
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("@/components/ai-agents/agent-profile-section", () => ({ AgentProfileSection: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

const { default: AiAgentsOverviewPage } = await import("./page");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(AiAgentsOverviewPage));
  });
}

function setCtx(subAccount: Record<string, unknown> | null, loading: boolean) {
  ctx.value = { ...ctx.value, subAccount, loading };
}

/** The status pill on a channel card. */
function status(slug: string): string | null {
  const card = container.querySelector(`a[href*="/ai-agents/${slug}"]`);
  return card ? (card.querySelector("span.rounded-full")?.textContent ?? null) : null;
}
const smsStatus = () => status("sms");

/** Web Chat channel config the fetch returns. */
let webChatConfig: Record<string, unknown> | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Every channel fetch resolves at once with SMS enabled.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        config: url.endsWith("/sms")
          ? { enabled: true }
          : url.endsWith("/web-chat")
            ? webChatConfig
            : null,
      }),
    })),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AiAgentsOverviewPage channel status", () => {
  it("shows neither a status nor the SMS nag while the workspace is loading", async () => {
    setCtx(null, true);
    await render();
    expect(container.textContent).toContain("Loading channel status");
    expect(container.textContent).not.toContain("Not configured");
    expect(container.textContent).not.toContain("See warning");
    expect(smsStatus()).toBeNull();
  });

  it("shows SMS not configured and the nag once loaded without Twilio", async () => {
    setCtx({}, false);
    await render();
    expect(smsStatus()).toBe("Not configured");
    expect(container.textContent).toContain("See warning");
  });

  it("shows SMS active and no nag once loaded with Twilio", async () => {
    setCtx({ twilioConfig: { enabled: true } }, false);
    await render();
    expect(smsStatus()).toBe("Active");
    expect(container.textContent).not.toContain("See warning");
  });
});

describe("AiAgentsOverviewPage Web Chat status", () => {
  const configured = { enabled: true, webChat: { allowedDomains: ["example.com"] } };
  afterEach(() => {
    webChatConfig = null;
  });

  it("shows Web Chat active when the channel is on and the agency allows it", async () => {
    webChatConfig = configured;
    setCtx({}, false);
    await render();
    expect(status("web-chat")).toBe("Active");
  });

  it("shows Web Chat not configured when the agency has locked it", async () => {
    webChatConfig = configured;
    setCtx({ webChatEnabledByAgency: false }, false);
    await render();
    expect(status("web-chat")).toBe("Not configured");
  });

  it("shows Web Chat not configured when the channel is off", async () => {
    webChatConfig = { ...configured, enabled: false };
    setCtx({}, false);
    await render();
    expect(status("web-chat")).toBe("Not configured");
  });

  it("shows Web Chat not configured when the widget block is missing", async () => {
    webChatConfig = { enabled: true };
    setCtx({}, false);
    await render();
    expect(status("web-chat")).toBe("Not configured");
  });

  it("shows Web Chat not configured while no site is allowed to embed it", async () => {
    webChatConfig = { enabled: true, webChat: { allowedDomains: [] } };
    setCtx({}, false);
    await render();
    expect(status("web-chat")).toBe("Not configured");
  });
});
