import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { stringsSentToClient } from "@/test/sent-to-client";

/**
 * The web-chat accent on its two ways out of the server: the config the
 * widget script fetches (and writes into a style on the embedding site),
 * and the props of the chat iframe's page. A stored value that is not the
 * plain hex the settings route writes is replaced by the default on both.
 */

const stored = vi.hoisted(() => ({ accentColor: "#0ea5e9" as unknown }));
vi.mock("@/lib/comms/ai/agent", () => ({
  getChannelConfig: async () => ({
    enabled: true,
    webChat: { allowedDomains: ["shop.example"], welcomeMessage: "Hello", accentColor: stored.accentColor, position: "left" },
  }),
}));
vi.mock("@/lib/comms/ai/gates", () => ({ aiChannelGateOn: () => true }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ agencyId: "ag1" }) }) }) }),
}));
vi.mock("@/components/web-chat/chat-window", () => ({
  ChatWindow: (p: { accentColor: string }) => `chat:${p.accentColor}`,
}));

const { GET } = await import("./route");
const { default: EmbedChatPage } = await import("@/app/(embed)/embed/chat/[subAccountId]/page");

const config = async () =>
  (await (await GET(new Request("https://app.example/api/web-chat/config?sa=sa1", { headers: { origin: "https://shop.example" } }))).json()) as Record<string, unknown>;
const page = () => EmbedChatPage({ params: Promise.resolve({ subAccountId: "sa1" }) });

const HOSTILE = [
  ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
  ["a hex followed by more CSS", "#0ea5e9;background:url(https://evil.example/x)"],
  ["a style-closing sequence", "red}</style><script src=https://evil.example/x></script>"],
  ["a 3-digit hex, which the settings route never stores", "#f50"],
  ["a non-string", ["#aabbcc"]],
] as const;

beforeEach(() => {
  stored.accentColor = "#0ea5e9";
});

describe("the web-chat accent leaving the server", () => {
  it("sends a real accent to the widget and to the chat page", async () => {
    expect(await config()).toEqual({ enabled: true, voiceEnabled: false, welcomeMessage: "Hello", accentColor: "#0ea5e9", position: "left" });
    const el = (await page()) as ReactElement<{ accentColor: string }>;
    expect(el.props.accentColor).toBe("#0ea5e9");
  });

  it.each(HOSTILE)("replaces a stored accent that is %s with the default", async (_label, accent) => {
    stored.accentColor = accent;
    const body = await config();
    expect(body.accentColor).toBe("#7c3aed");
    expect(JSON.stringify(body)).not.toMatch(/evil\.example|#aabbcc|#f50/);

    const el = (await page()) as ReactElement<{ accentColor: string }>;
    expect(el.props.accentColor).toBe("#7c3aed");
    expect(stringsSentToClient(el).filter((s) => /evil\.example|#aabbcc|#f50/.test(s))).toEqual([]);
    expect(renderToStaticMarkup(el)).toBe("chat:#7c3aed");
  });
});
