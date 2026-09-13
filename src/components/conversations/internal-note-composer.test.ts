// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Contact } from "@/types/contacts";

/**
 * SP2 T2 — the composer's Internal note mode writes a contact note marked
 * `source: "conversation"` and never calls a send route.
 */
const m = vi.hoisted(() => ({ addNote: vi.fn(), fetch: vi.fn() }));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount: {} }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "u1" } }) }));
vi.mock("@/lib/firestore/contacts", () => ({ addNote: m.addNote }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

import { ConversationComposer } from "./conversation-composer";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", m.fetch);
  m.fetch.mockReset();
  m.addNote.mockReset().mockResolvedValue("n1");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function type(text: string) {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!
      .set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}
async function clickTab(label: string) {
  const tab = [...container.querySelectorAll('[role="tab"]')].find(
    (el) => el.textContent === label
  ) as HTMLButtonElement;
  await act(async () => tab.click());
}
async function submit() {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
}

it("saves a conversation-sourced contact note and sends nothing", async () => {
  const contact = { id: "c1", phone: "+27820000000" } as Contact;
  await act(async () =>
    root.render(
      createElement(ConversationComposer, {
        contact,
        availableChannels: ["sms", "whatsapp"],
        defaultChannel: "sms",
      })
    )
  );
  await clickTab("Internal note");
  const textarea = await type("  Customer prefers mornings  ");
  expect(textarea.getAttribute("aria-label")).toBe("Internal note");
  await submit();
  expect(m.addNote).toHaveBeenCalledWith(
    "c1",
    "Customer prefers mornings",
    "u1",
    "conversation"
  );
  expect(m.fetch).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")!.value).toBe("");
  // No channel picker in note mode — there is no recipient to pick.
  expect(container.textContent).not.toContain("Send via");
});

it("offers note mode even when no messaging channel is configured", async () => {
  const contact = { id: "c1" } as Contact;
  await act(async () =>
    root.render(
      createElement(ConversationComposer, {
        contact,
        availableChannels: [],
        defaultChannel: "sms",
      })
    )
  );
  expect(container.textContent).toContain("No messaging channel");
  await clickTab("Internal note");
  await type("Called, no answer");
  await submit();
  expect(m.addNote).toHaveBeenCalledWith("c1", "Called, no answer", "u1", "conversation");
  expect(m.fetch).not.toHaveBeenCalled();
});

it("Reply mode still posts to the send route (the toggle does not break it)", async () => {
  m.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  const contact = { id: "c1", phone: "+27820000000" } as Contact;
  await act(async () =>
    root.render(
      createElement(ConversationComposer, {
        contact,
        availableChannels: ["sms"],
        defaultChannel: "sms",
      })
    )
  );
  await clickTab("Internal note");
  await clickTab("Reply");
  await type("Hi");
  await submit();
  expect(m.fetch.mock.calls[0][0]).toBe("/api/comms/sms/send");
  expect(m.addNote).not.toHaveBeenCalled();
});
