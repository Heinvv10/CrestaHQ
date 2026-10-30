// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";

/**
 * When an outbound WhatsApp row was sent as an interactive BUTTON message,
 * the thread must show the buttons the customer actually received — not
 * just the body text. Historic rows (no `buttons` field) render unchanged.
 */
const state = vi.hoisted(() => ({ unsub: vi.fn() }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  orderBy: () => null,
  limit: () => null,
  query: (path: string) => path,
  onSnapshot: (path: string, receive: (snap: unknown) => void) => {
    if (path === "contacts/c1/whatsappMessages") {
      receive({
        docs: [
          {
            id: "wa1",
            data: () => ({
              direction: "outbound",
              status: "sent",
              body: "Thank you! If you have a moment, a review would help.",
              buttons: [{ type: "quick_reply", text: "Yes, all good" }, { type: "quick_reply", text: "No, a problem" }],
              createdAt: null,
            }),
          },
          {
            id: "wa2",
            data: () => ({
              direction: "outbound",
              status: "sent",
              body: "Leave us a review?",
              buttons: [{ type: "url", text: "Leave a review", url: "https://g.page/r/velocity/review" }],
              createdAt: null,
            }),
          },
          {
            id: "wa3",
            data: () => ({
              direction: "outbound",
              status: "sent",
              body: "Plain text, no buttons.",
              createdAt: null,
            }),
          },
        ],
      });
      return state.unsub;
    }
    receive({ docs: [] });
    return state.unsub;
  },
}));

it("renders quick-reply and url buttons on interactive rows, and nothing extra on a plain row", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.unsub.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConversationThread, { contactId: "c1" })));

    expect(container.textContent).toContain("Yes, all good");
    expect(container.textContent).toContain("No, a problem");
    expect(container.textContent).toContain("Leave a review");
    expect(container.textContent).toContain("https://g.page/r/velocity/review");
    expect(container.textContent).toContain("Plain text, no buttons.");
    // Exactly two chip rows (wa1, wa2) — the plain row (wa3) gets no
    // buttons container, so no empty div and no extra layout.
    const bubbles = container.querySelectorAll("[class*='max-w-\\[78\\%\\]']");
    expect(bubbles).toHaveLength(3);
    const plainBubble = Array.from(bubbles).find((b) => b.textContent?.includes("Plain text"));
    expect(plainBubble?.querySelector(".flex-wrap")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
