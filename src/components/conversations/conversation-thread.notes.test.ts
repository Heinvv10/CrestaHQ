// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

/**
 * SP2 T2 — internal notes render inline in the thread, as notes (not
 * bubbles), in time order between the messages around them.
 */
const at = (ms: number) => ({ toDate: () => new Date(ms) });
const rows: Record<string, { id: string; data: Record<string, unknown> }[]> = {
  "contacts/c1/messages": [
    { id: "m1", data: { direction: "inbound", body: "first message", createdAt: at(1000) } },
    { id: "m3", data: { direction: "outbound", body: "third message", createdAt: at(3000) } },
  ],
  "contacts/c1/notes": [
    { id: "n2", data: { content: "second: internal", createdBy: "u1", source: "conversation", createdAt: at(2000) } },
  ],
};
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, ...segs: string[]) => segs.join("/"),
  orderBy: () => null,
  limit: () => null,
  query: (path: string) => path,
  onSnapshot: (path: string, receive: (snap: unknown) => void) => {
    receive({
      docs: (rows[path] ?? []).map((r) => ({ id: r.id, data: () => r.data })),
    });
    return () => {};
  },
}));

import { ConversationThread } from "./conversation-thread";

it("interleaves an internal note between messages and marks it not sent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(ConversationThread, { contactId: "c1" }))
    );
    const text = container.textContent ?? "";
    const i1 = text.indexOf("first message");
    const i2 = text.indexOf("second: internal");
    const i3 = text.indexOf("third message");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    const notes = container.querySelectorAll('[data-testid="thread-note"]');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain("Internal note · not sent");
    expect(notes[0].textContent).toContain("second: internal");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
