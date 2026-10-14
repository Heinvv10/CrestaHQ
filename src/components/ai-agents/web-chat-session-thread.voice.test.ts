// @vitest-environment jsdom
import { act, createElement, type AnchorHTMLAttributes } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebChatSessionThread } from "./web-chat-session-thread";

vi.mock("next/link", () => ({
  default: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement("a", { href: String(href), ...props }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "u1" } }) }));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccountId: "sa1", isAdmin: true }),
}));
vi.mock("@/lib/firestore/tasks", () => ({ subscribeToTask: vi.fn() }));
vi.mock("@/lib/client/tasks", () => ({ markTaskComplete: vi.fn() }));
vi.mock("@/lib/format", () => ({ formatRelativeTime: () => "now" }));
vi.mock("@/lib/firestore/web-chat-sessions", () => ({
  subscribeToWebChatSession: (
    _subAccountId: string,
    _sessionId: string,
    receive: (value: object) => void,
  ) => {
    receive({
      id: "abcdefghijklmnop",
      status: "active",
      contactId: null,
      messageCount: 1,
      tokensUsed: 0,
      createdAt: null,
      updatedAt: null,
      lastMessageAt: null,
    });
    return vi.fn();
  },
  subscribeToWebChatMessages: (
    _subAccountId: string,
    _sessionId: string,
    receive: (value: object[]) => void,
  ) => {
    receive([
      {
        id: "v1",
        direction: "outbound",
        body: "Spoken answer",
        via: "voice",
        createdAt: null,
      },
    ]);
    return vi.fn();
  },
}));

afterEach(() => vi.unstubAllGlobals());

describe("WebChatSessionThread voice marker", () => {
  it("marks a spoken transcript row", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(WebChatSessionThread, { sessionId: "abcdefghijklmnop" }),
        ),
      );
      expect(host.textContent).toContain("Spoken answer");
      expect(host.querySelector('[aria-label="Spoken (voice)"]')?.textContent).toContain(
        "voice",
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
});
