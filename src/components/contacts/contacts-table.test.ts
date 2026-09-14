// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Contact } from "@/types/contacts";

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({
    subAccount: null,
    saPath: (p: string) => `/sa/sa1${p}`,
  }),
}));

import { ContactsTable, RENDER_STEP } from "./contacts-table";

/**
 * A 4,551-contact sub-account froze the tab for 8s because every contact
 * was rendered twice (desktop table + hidden mobile cards). The table now
 * renders RENDER_STEP rows at a time; sorting must still run over the full
 * list, so the newest contact is on top even when it arrives last.
 */
function contacts(n: number): Contact[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    name: `Contact ${i}`,
    email: "",
    phone: "",
    company: "",
    address: "",
    source: "manual",
    tags: [],
    pipelineStage: null,
    attribution: null,
    // Ascending age: the LAST contact is the newest.
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
  })) as unknown as Contact[];
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function mount(list: Contact[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      createElement(ContactsTable, {
        contacts: list,
        selected: new Set<string>(),
        onToggle: () => undefined,
        onToggleAll: () => undefined,
        allSelected: false,
        someSelected: false,
      }),
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    el.remove();
  };
  return {
    tableRows: () => el.querySelectorAll("tbody tr").length,
    cards: () => el.querySelectorAll(".md\\:hidden > div").length,
    firstRowText: () => el.querySelector("tbody tr")?.textContent ?? "",
    moreButton: () =>
      [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("Show "),
      ),
  };
}

it("renders one step of rows in both the table and the mobile cards", async () => {
  const m = await mount(contacts(250));
  expect(m.tableRows()).toBe(RENDER_STEP);
  expect(m.cards()).toBe(RENDER_STEP);
  expect(m.moreButton()?.textContent).toBe(`Show ${RENDER_STEP} more`);
});

it("sorts the full list before capping — the newest contact is first", async () => {
  const m = await mount(contacts(250));
  expect(m.firstRowText()).toContain("Contact 249");
});

it("Show more reveals the next step, then the remainder, then disappears", async () => {
  const m = await mount(contacts(250));
  await act(async () => m.moreButton()!.click());
  expect(m.tableRows()).toBe(200);
  expect(m.moreButton()?.textContent).toBe("Show 50 more");
  await act(async () => m.moreButton()!.click());
  expect(m.tableRows()).toBe(250);
  expect(m.cards()).toBe(250);
  expect(m.moreButton()).toBeUndefined();
});

it("a list under one step renders whole with no button", async () => {
  const m = await mount(contacts(7));
  expect(m.tableRows()).toBe(7);
  expect(m.moreButton()).toBeUndefined();
});
