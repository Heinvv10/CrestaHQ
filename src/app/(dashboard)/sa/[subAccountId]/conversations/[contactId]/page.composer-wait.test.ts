// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initialComposerChannel,
  type ChannelOption,
} from "@/lib/conversations/channel-availability";

/**
 * On a hard load the composer used to mount while the workspace doc was still
 * null, so every agency-gated channel read as off, the composer's opening
 * channel fell back to another one, and its useState kept it after the doc
 * arrived — a WhatsApp thread opened on SMS. It must wait for the workspace.
 */

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    subAccount: null as Record<string, unknown> | null,
    saPath: (p: string) => `/sa/sa1${p}`,
    loading: true,
  },
}));
const composer = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
// Stable identity: the page's subscribe effects depend on `user`.
const auth = vi.hoisted(() => ({ user: { uid: "u1", displayName: "Op" }, loading: false }));

vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/hooks/use-conversation-theme", () => ({
  useConversationTheme: () => ({ theme: "standard", setTheme: () => {} }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ contactId: "c1" }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as never),
}));
vi.mock("@/lib/firestore/contacts", () => ({
  subscribeToContact: (_id: string, cb: (c: unknown) => void) => {
    cb({ id: "c1", name: "Thandi", phone: "+27820000000" });
    return () => {};
  },
}));
vi.mock("@/lib/firestore/conversations", () => ({
  subscribeToConversation: (_id: string, cb: (c: unknown) => void) => {
    cb({ id: "c1", contactId: "c1", lastChannel: "whatsapp", channelsSeen: ["whatsapp"] });
    return () => {};
  },
  markConversationRead: () => Promise.resolve(),
}));
vi.mock("@/components/conversations/conversation-composer", () => ({
  ConversationComposer: (props: Record<string, unknown>) => {
    composer.props.push(props);
    return createElement("div", { "data-testid": "composer" });
  },
}));
vi.mock("@/components/conversations/conversation-thread", () => ({ ConversationThread: () => null }));
vi.mock("@/components/conversations/web-chat-composer", () => ({ WebChatComposer: () => null }));
vi.mock("@/components/conversations/conversation-ai-controls", () => ({ ConversationAiControls: () => null }));
vi.mock("@/components/conversations/conversation-draft-card", () => ({ ConversationDraftCard: () => null }));
vi.mock("@/components/conversations/conversation-contact-panel", () => ({ ConversationContactPanel: () => null }));
vi.mock("@/components/conversations/conversation-owner", () => ({ ConversationOwner: () => null }));
vi.mock("@/components/conversations/thread-header-actions", () => ({
  DetailsToggle: () => null,
  ThreadTriageActions: () => null,
}));

const { default: ConversationDetailPage } = await import("./page");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(ConversationDetailPage));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  composer.props = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ConversationDetailPage composer", () => {
  it("waits for the workspace doc, then opens on the thread's WhatsApp channel", async () => {
    // Hard load: contact + conversation have arrived, the workspace has not.
    ctx.value = { ...ctx.value, subAccount: null, loading: true };
    await render();
    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    expect(composer.props).toHaveLength(0);

    // The workspace doc arrives with the WhatsApp gate on and a sender.
    ctx.value = {
      ...ctx.value,
      subAccount: {
        whatsappEnabledByAgency: true,
        twilioConfig: { whatsappFromNumber: "+27110000000" },
      },
      loading: false,
    };
    await render();
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();

    // Every render the composer ever saw had WhatsApp usable, so its opening
    // channel (initialComposerChannel, frozen in its useState) is WhatsApp.
    expect(composer.props.length).toBeGreaterThan(0);
    for (const props of composer.props) {
      const options = props.channelOptions as ChannelOption[];
      expect(props.defaultChannel).toBe("whatsapp");
      expect(options.find((o) => o.channel === "whatsapp")?.available).toBe(true);
      expect(props.availableChannels).toContain("whatsapp");
      expect(initialComposerChannel(options, "whatsapp")).toBe("whatsapp");
    }
  });

  it("stays mounted if loading flips back on with the doc in hand", async () => {
    ctx.value = {
      ...ctx.value,
      subAccount: {
        whatsappEnabledByAgency: true,
        twilioConfig: { whatsappFromNumber: "+27110000000" },
      },
      loading: false,
    };
    await render();
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
    ctx.value = { ...ctx.value, loading: true };
    await render();
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
  });
});
