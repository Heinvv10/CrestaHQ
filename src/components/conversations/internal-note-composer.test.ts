// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Contact } from "@/types/contacts";

/**
 * SP2 T2 — the composer's Internal note mode writes a contact note marked
 * `source: "conversation"` and never calls a send route. Its only requests
 * are the team roster (for @mentions) and, when someone is mentioned, the
 * mention-tasks route.
 */
const m = vi.hoisted(() => ({ addNote: vi.fn(), fetch: vi.fn() }));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount: {}, subAccountId: "sa1" }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "u1" } }) }));
vi.mock("@/lib/firestore/contacts", () => ({ addNote: m.addNote }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

import { ConversationComposer } from "./conversation-composer";

const ROSTER = "/api/sub-accounts/sa1/members";
/** Every request except the roster read. */
const requests = () => m.fetch.mock.calls.filter(([url]) => url !== ROSTER);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", m.fetch);
  m.fetch.mockReset().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url === ROSTER
        ? {
            members: [
              { uid: "u1", displayName: "Hein", email: "", role: "admin" },
              { uid: "mike", displayName: "Michael Smith", email: "", role: "collaborator" },
              { uid: "mia", displayName: "mia@x.co", email: "mia@x.co", role: "collaborator" },
            ],
          }
        : { ok: true, taskIds: [] },
  }));
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
    "conversation",
    []
  );
  expect(requests()).toEqual([]);
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
  expect(m.addNote).toHaveBeenCalledWith("c1", "Called, no answer", "u1", "conversation", []);
  expect(requests()).toEqual([]);
});

it("Reply mode still posts to the send route (the toggle does not break it)", async () => {
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
  expect(requests()[0][0]).toBe("/api/comms/sms/send");
  expect(m.addNote).not.toHaveBeenCalled();
});

it("Reply on an email while in note mode switches back to Reply — even the same email twice", async () => {
  const contact = { id: "c1", email: "c@x.co" } as Contact;
  const email = {
    contactId: "c1",
    subject: "Question",
    messageId: "<m@x>",
    references: [],
    inReplyTo: null,
  };
  const render = (emailReply: unknown) =>
    act(async () =>
      root.render(
        createElement(ConversationComposer, {
          contact,
          availableChannels: ["sms", "email"],
          defaultChannel: "sms",
          emailReply: emailReply as never,
        })
      )
    );
  await render(null);
  await clickTab("Internal note");
  expect(container.querySelector('[data-testid="internal-note-composer"]')).not.toBeNull();
  await render(email);
  expect(container.querySelector('[data-testid="internal-note-composer"]')).toBeNull();
  const subject = container.querySelector(
    'input[aria-label="Email subject"]'
  ) as HTMLInputElement;
  expect(subject.value).toBe("Re: Question");
  // Back to note mode, then Reply on the same email again (the page hands a
  // fresh copy per click).
  await clickTab("Internal note");
  await render({ ...email });
  expect(container.querySelector('[data-testid="internal-note-composer"]')).toBeNull();
  expect(container.textContent).toContain("Send via Email");
});

// ---- @mentions ----

const MENTION_URL = "/api/sub-accounts/sa1/contacts/c1/notes/n1/mention-tasks";

async function renderComposer() {
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
}
async function key(k: string) {
  const textarea = container.querySelector("textarea")!;
  await act(async () =>
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }))
  );
}
/** Let the pick's requestAnimationFrame (focus + caret) run. */
const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
const options = () =>
  [...container.querySelectorAll('[role="option"]')].map((o) => o.textContent);

it("offers matching members after @ + letters and records the picked one", async () => {
  await renderComposer();
  await clickTab("Internal note");
  await type("Please ask @mi");
  // Name prefix (Michael Smith) and, for a member with no display name, the
  // email the roster shows instead (mia@x.co); not Hein.
  expect(options()).toEqual(["Michael Smith", "mia@x.co"]);
  await key("Enter");
  await frame();
  expect(container.querySelector("textarea")!.value).toBe("Please ask @Michael Smith ");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await type("Please ask @Michael Smith to call back");
  await submit();
  expect(m.addNote).toHaveBeenCalledWith(
    "c1",
    "Please ask @Michael Smith to call back",
    "u1",
    "conversation",
    ["mike"]
  );
  expect(requests()).toEqual([[MENTION_URL, { method: "POST" }]]);
});

it("matches any word of the name, moves with the arrows and picks with Tab", async () => {
  await renderComposer();
  await clickTab("Internal note");
  await type("@m");
  expect(options()).toEqual(["Michael Smith", "mia@x.co"]);
  await key("ArrowDown");
  await key("Tab");
  await frame();
  expect(container.querySelector("textarea")!.value).toBe("@mia@x.co ");
  await type("cc @smi");
  expect(options()).toEqual(["Michael Smith"]);
});

it("a click picks; Esc closes the list", async () => {
  await renderComposer();
  await clickTab("Internal note");
  await type("@He");
  await key("Escape");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await type("@He @Mi");
  const option = container.querySelector('[role="option"]')!;
  expect(option.textContent).toBe("Michael Smith");
  await act(async () =>
    option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
  );
  await frame();
  expect(container.querySelector("textarea")!.value).toBe("@He @Michael Smith ");
});

it("drops a picked member whose @Name was deleted before saving", async () => {
  await renderComposer();
  await clickTab("Internal note");
  await type("@Mi");
  await key("Enter");
  await frame();
  await type("Michael will call back");
  await submit();
  expect(m.addNote).toHaveBeenCalledWith(
    "c1",
    "Michael will call back",
    "u1",
    "conversation",
    []
  );
  expect(requests()).toEqual([]);
});

it("Reply mode never shows the mention list", async () => {
  await renderComposer();
  // Load the roster first, so an autocomplete would have names to offer.
  await clickTab("Internal note");
  await clickTab("Reply");
  await type("Hi @Mi");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await key("Enter");
  expect(container.querySelector("textarea")!.value).toBe("Hi @Mi");
});
