// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ContactWhatsappThread } from "./contact-whatsapp-thread";
import type { Contact } from "@/types/contacts";

/**
 * The contact-profile WhatsApp thread carries the same button-rendering block
 * as the conversations thread. Without this test nothing would go red if that
 * copy broke, since the two renderers share no code.
 */
const state = vi.hoisted(() => ({ unsub: vi.fn() }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount: { whatsappProvider: "cloud" } }),
}));
vi.mock("@/components/contacts/whatsapp-template-sender", () => ({
  WhatsappTemplateSender: () => null,
}));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  doc: () => null,
  orderBy: () => null,
  query: (path: string) => path,
  serverTimestamp: () => null,
  setDoc: vi.fn(async () => undefined),
  onSnapshot: (path: string, receive: (snap: unknown) => void) => {
    receive({
      docs: [
        {
          id: "wa1",
          data: () => ({
            direction: "outbound",
            status: "sent",
            body: "Thank you! If you have a moment, a review would help.",
            buttons: [
              { type: "quick_reply", text: "Yes, all good" },
              { type: "quick_reply", text: "No, a problem" },
            ],
            createdAt: null,
          }),
        },
        {
          id: "wa2",
          data: () => ({
            direction: "outbound",
            status: "sent",
            body: "Leave us a review?",
            buttons: [
              { type: "url", text: "Leave a review", url: "https://g.page/r/velocity/review" },
            ],
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
  },
}));

const contact = { id: "c1", phone: "+27821112222" } as Contact;

it("renders quick-reply and url buttons, and no chip container on a plain row", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.unsub.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ContactWhatsappThread, { contact })));

    expect(container.textContent).toContain("Yes, all good");
    expect(container.textContent).toContain("No, a problem");
    expect(container.textContent).toContain("Leave a review");
    expect(container.textContent).toContain("https://g.page/r/velocity/review");
    expect(container.textContent).toContain("Plain text, no buttons.");

    const bubbles = container.querySelectorAll("[class*='max-w-\\[78\\%\\]']");
    expect(bubbles).toHaveLength(3);
    const plainBubble = Array.from(bubbles).find((b) =>
      b.textContent?.includes("Plain text"),
    );
    expect(plainBubble?.querySelector(".flex-wrap")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
