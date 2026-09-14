// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationDoc } from "@/types/conversations";

vi.mock("@/lib/firestore/conversations", () => ({
  setConversationStarred: vi.fn(),
}));

import { ConversationList } from "./conversation-list";
import { RENDER_STEP } from "@/components/show-more-rows";

/**
 * Rendering Velocity's whole inbox blocked the main thread for 5.5s. The
 * list renders RENDER_STEP rows at a time, in the order the page sorted
 * them.
 */
function convos(n: number): ConversationDoc[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `conv${i}`,
    contactName: `Person ${i}`,
    lastMessagePreview: "hi",
    lastChannel: "whatsapp",
    lastDirection: "inbound",
    unreadCount: 0,
  })) as unknown as ConversationDoc[];
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function mount(list: ConversationDoc[], activeId: string | null = null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      createElement(ConversationList, {
        conversations: list,
        basePath: "/sa/sa1/conversations",
        activeId,
      }),
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    el.remove();
  };
  const rows = () => el.querySelectorAll('[data-testid="conversation-row"]');
  return {
    rows,
    activeRow: () => el.querySelector('[aria-current="page"]'),
    moreButton: () =>
      [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("Show "),
      ),
  };
}

it("renders one step, in the order given", async () => {
  const m = await mount(convos(230));
  expect(m.rows().length).toBe(RENDER_STEP);
  expect(m.rows()[0].textContent).toContain("Person 0");
  expect(m.moreButton()?.textContent).toBe(`Show ${RENDER_STEP} more`);
});

it("Show more reveals the rest step by step, then disappears", async () => {
  const m = await mount(convos(230));
  await act(async () => m.moreButton()!.click());
  expect(m.rows().length).toBe(200);
  expect(m.moreButton()?.textContent).toBe("Show 30 more");
  await act(async () => m.moreButton()!.click());
  expect(m.rows().length).toBe(230);
  expect(m.moreButton()).toBeUndefined();
});

it("an open thread past the cap is still rendered and highlighted", async () => {
  const m = await mount(convos(230), "conv150");
  expect(m.rows().length).toBe(151);
  expect(m.activeRow()?.textContent).toContain("Person 150");
  expect(m.moreButton()?.textContent).toBe("Show 79 more");
  await act(async () => m.moreButton()!.click());
  expect(m.rows().length).toBe(230);
});

it("a short inbox renders whole with no button", async () => {
  const m = await mount(convos(3));
  expect(m.rows().length).toBe(3);
  expect(m.moreButton()).toBeUndefined();
});
