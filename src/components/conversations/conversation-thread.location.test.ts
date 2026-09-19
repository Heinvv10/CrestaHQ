// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";

/**
 * A shared location in the unified inbox thread. The customer controls every
 * string on the row, so the one link must be built from the coordinates and
 * the strings must render as inert text.
 */
const state = vi.hoisted(() => ({
  unsub: vi.fn(),
  rows: [
    {
      id: "wa1",
      data: () => ({
        direction: "inbound",
        status: "received",
        body: "📍 <img src=x onerror=alert(1)>",
        location: {
          latitude: -26.3812,
          longitude: 27.8123,
          name: "<img src=x onerror=alert(1)>",
          address: "12 Main Rd, Lawley",
          url: "javascript:alert(1)",
        },
        createdAt: null,
      }),
    },
    {
      id: "wa2",
      data: () => ({
        direction: "inbound",
        status: "received",
        body: "on my way",
        location: { latitude: -33.9249, longitude: 18.4241 },
        createdAt: null,
      }),
    },
    {
      id: "wa3",
      data: () => ({
        direction: "inbound",
        status: "received",
        body: "📍 Location",
        location: { latitude: 200, longitude: 18.4 },
        createdAt: null,
      }),
    },
  ],
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  orderBy: () => null,
  limit: () => null,
  query: (path: string) => path,
  onSnapshot: (path: string, receive: (snap: unknown) => void) => {
    receive({ docs: path === "contacts/c1/whatsappMessages" ? state.rows : [] });
    return state.unsub;
  },
}));

it("links to Google Maps from the numbers only and renders customer strings as text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConversationThread, { contactId: "c1" })));

    const links = Array.from(container.querySelectorAll("a")).filter(
      (a) => a.textContent === "Open in Google Maps",
    );
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://www.google.com/maps/search/?api=1&query=-26.381200,27.812300",
      "https://www.google.com/maps/search/?api=1&query=-33.924900,18.424100",
    ]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
    }
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("12 Main Rd, Lawley");
    expect(container.textContent).toContain("-26.381200, 27.812300");
    expect(container.textContent).not.toContain("javascript:alert(1)");

    const bubbles = Array.from(container.querySelectorAll("[class*='max-w-\\[78\\%\\]']"));
    expect(bubbles).toHaveLength(3);
    // The synthesised label is not repeated above the card…
    expect(bubbles[0].textContent).not.toContain("📍");
    // …but a caption the customer typed still shows.
    expect(bubbles[1].textContent).toContain("on my way");
    // A stored row with unusable coordinates gets no card, just its body.
    expect(bubbles[2].querySelector("a")).toBeNull();
    expect(bubbles[2].textContent).toContain("📍 Location");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
