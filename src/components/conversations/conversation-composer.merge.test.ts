// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationComposer } from "./conversation-composer";
import type { Contact } from "@/types/contacts";
import type { ConversationChannel } from "@/types/conversations";
import type { EmailMessageDoc } from "@/types/email";

/**
 * SP2 T4 at the composer seam: inserts render once, Send never rewrites the
 * message and never posts one that still holds a `{{…}}`, and the only
 * render after insert is the operator's explicit "Fill merge fields".
 */

const sa = vi.hoisted(() => ({
  subAccount: {
    name: "Velo Desk",
    googleReviewConfig: {
      reviewUrl: "https://g.page/r/velo",
      messageTemplate: "",
    },
  } as Record<string, unknown>,
}));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({
    subAccount: sa.subAccount,
    subAccountId: "sa1",
    saPath: (p: string) => `/sa/sa1${p}`,
  }),
}));
const toasts = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toasts }));
// The real picker is a base-ui menu (portals + pointer events); a plain button
// per field drives the SAME onPick the composer passes to it.
vi.mock("@/components/snippets/merge-field-menu", async () => {
  const { MERGE_FIELDS } = await import("@/lib/messaging/merge-tags");
  const { createElement: h } = await import("react");
  return {
    MergeFieldMenu: ({ onPick }: { onPick: (tag: string) => void }) =>
      h(
        "div",
        null,
        MERGE_FIELDS.map((f) =>
          h(
            "button",
            { key: f.tag, type: "button", onClick: () => onPick(f.tag) },
            `field:${f.label}`
          )
        )
      ),
  };
});

const SNIPPETS = [
  {
    id: "e1",
    name: "Quote mail",
    body: "Dear {{contact.first_name}}",
    type: "email",
    subject: "Quote for {{contact.first_name}}",
    folder: null,
  },
];
const sendMock = vi.fn();
let container: HTMLDivElement;
let root: Root;
const baseContact = {
  id: "c1",
  name: "  Thabo Mokoena",
  phone: "+27825550100",
  email: "",
  smsOptedOut: false,
  emailOptedOut: false,
} as Contact;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sendMock.mockReset();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.includes("/snippets")) {
      return { ok: true, json: async () => ({ snippets: SNIPPETS }) };
    }
    sendMock(url, init);
    return { ok: true, json: async () => ({ ok: true }) };
  });
  Object.values(toasts).forEach((t) => t.mockClear());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(
  contact: Partial<Contact> = {},
  opts: {
    channels?: ConversationChannel[];
    emailReply?: EmailMessageDoc | null;
  } = {}
) {
  const channels = opts.channels ?? ["sms"];
  await act(async () =>
    root.render(
      createElement(ConversationComposer, {
        contact: { ...baseContact, ...contact } as Contact,
        availableChannels: channels,
        defaultChannel: channels[0],
        senderName: "Anele",
        emailReply: opts.emailReply ?? null,
      })
    )
  );
  return container.querySelector("textarea")!;
}
async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (text: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text
  ) ?? null;
const click = (text: string) => act(async () => button(text)!.click());
const submit = () =>
  act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
const notice = () => container.querySelector("[data-testid='merge-error']");
const sentBody = (i = 0) => JSON.parse(sendMock.mock.calls[i][1].body).body;

it("Ask for review renders the legacy default template exactly as before", async () => {
  const textarea = await mount();
  await click("Ask for review");
  expect(textarea.value).toBe(
    "Hi Thabo, thanks for choosing Velo Desk! If you have a moment, a quick Google review would mean a lot: https://g.page/r/velo"
  );
});

it("a tag with no value blocks Send stably and cannot be filled", async () => {
  const textarea = await mount();
  await type(textarea, "We emailed {{contact.email}}");
  await submit();
  await submit();
  expect(sendMock).not.toHaveBeenCalled();
  expect(textarea.value).toBe("We emailed {{contact.email}}");
  expect(notice()?.textContent).toContain("{{contact.email}}");
  expect(button("Fill merge fields")).toBeNull();
  // Editing clears the refusal; a clean message then sends as typed.
  await type(textarea, "Hi Thabo");
  expect(notice()).toBeNull();
  await submit();
  expect(sentBody()).toBe("Hi Thabo");
});

it("Send never renders typed tags; the explicit Fill does, once", async () => {
  const textarea = await mount();
  const typed =
    "Hi {{ contact.first_name }}, {{user.name}} from {{business.name}}";
  await type(textarea, typed);
  await submit();
  expect(sendMock).not.toHaveBeenCalled();
  expect(textarea.value).toBe(typed);
  await click("Fill merge fields");
  expect(textarea.value).toBe("Hi Thabo, Anele from Velo Desk");
  expect(notice()).toBeNull();
  await submit();
  expect(sentBody()).toBe("Hi Thabo, Anele from Velo Desk");
});

it("probe: a contact named {{business.name}} is never rewritten by Send", async () => {
  const textarea = await mount({ name: "{{business.name}}" });
  await click("field:Contact full name");
  expect(textarea.value).toBe("{{business.name}}");
  await submit();
  await submit();
  expect(sendMock).not.toHaveBeenCalled();
  expect(textarea.value).toBe("{{business.name}}");
  expect(notice()?.textContent).toContain("{{business.name}}");
});

it("probe: a contact named '{{contact.name}} x' cannot grow the message", async () => {
  const textarea = await mount({ name: "{{contact.name}} x" });
  await click("field:Contact full name");
  expect(textarea.value).toBe("{{contact.name}} x");
  await submit();
  await submit();
  expect(textarea.value).toBe("{{contact.name}} x");
  // The operator's explicit fill renders exactly once, then is withdrawn.
  await click("Fill merge fields");
  expect(textarea.value).toBe("{{contact.name}} x x");
  expect(button("Fill merge fields")).toBeNull();
  await submit();
  expect(textarea.value).toBe("{{contact.name}} x x");
  expect(sendMock).not.toHaveBeenCalled();
});

it("merge fields insert at the remembered caret: rendered, or raw when empty", async () => {
  const textarea = await mount();
  await type(textarea, "Hi !");
  await act(async () => {
    textarea.focus();
    textarea.setSelectionRange(3, 3);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    textarea.blur();
  });
  await click("field:Contact first name");
  expect(textarea.value).toBe("Hi Thabo!");
  // The caret lands after the insert (restored on the next frame).
  await act(() => new Promise((r) => setTimeout(r, 50)));
  expect(textarea.selectionStart).toBe(8);
  await click("field:Contact email");
  expect(textarea.value).toBe("Hi Thabo{{contact.email}}!");
});

it("a channel switch and the review insert both clear a stale refusal", async () => {
  const textarea = await mount(
    { email: "t@example.com" },
    { channels: ["sms", "email"] }
  );
  await type(textarea, "Hi {{foo}}");
  await submit();
  expect(notice()).not.toBeNull();
  await click("Email");
  expect(notice()).toBeNull();
  await click("SMS");
  await submit();
  expect(notice()).not.toBeNull();
  await click("Ask for review");
  expect(notice()).toBeNull();
});

async function pickEmailSnippet() {
  await click("Snippets");
  const item = await vi.waitFor(() => {
    const b =
      button("Quote mail · Email") ??
      [...container.querySelectorAll("button")].find((x) =>
        x.textContent?.startsWith("Quote mail")
      );
    if (!b) throw new Error("snippet not listed yet");
    return b;
  });
  await act(async () => item.click());
}

it("an email snippet fills an empty subject but never a reply's Re: subject", async () => {
  const textarea = await mount(
    { email: "t@example.com" },
    { channels: ["email"] }
  );
  const subject = container.querySelector<HTMLInputElement>(
    "input[aria-label='Email subject']"
  )!;
  await pickEmailSnippet();
  expect(textarea.value).toBe("Dear Thabo");
  expect(subject.value).toBe("Quote for Thabo");

  await act(async () => root.unmount());
  root = createRoot(container);
  const reply = {
    subject: "Question",
    messageId: "<one@example.com>",
    references: [],
  } as unknown as EmailMessageDoc;
  await mount(
    { email: "t@example.com" },
    { channels: ["email"], emailReply: reply }
  );
  const replySubject = container.querySelector<HTMLInputElement>(
    "input[aria-label='Email subject']"
  )!;
  expect(replySubject.value).toBe("Re: Question");
  await pickEmailSnippet();
  expect(container.querySelector("textarea")!.value).toBe("Dear Thabo");
  expect(replySubject.value).toBe("Re: Question");
});
