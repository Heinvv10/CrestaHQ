// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationComposer } from "./conversation-composer";
import type { Contact } from "@/types/contacts";

/**
 * SP2 T4 at the composer seam: the review insert renders through the shared
 * renderer with its old output, and Send never posts a message that still
 * holds a merge tag.
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

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;
const contact = {
  id: "c1",
  name: "  Thabo Mokoena",
  phone: "+27825550100",
  email: "",
  smsOptedOut: false,
} as Contact;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockReset()
    .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
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

async function mount() {
  await act(async () =>
    root.render(
      createElement(ConversationComposer, {
        contact,
        availableChannels: ["sms"],
        defaultChannel: "sms",
        senderName: "Anele",
      })
    )
  );
  return container.querySelector("textarea")!;
}
async function type(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = () =>
  act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );

it("Ask for review renders the legacy default template exactly as before", async () => {
  const textarea = await mount();
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Ask for review")
  )!;
  await act(async () => button.click());
  expect(textarea.value).toBe(
    "Hi Thabo, thanks for choosing Velo Desk! If you have a moment, a quick Google review would mean a lot: https://g.page/r/velo"
  );
});

it("Send is refused, visibly, while a tag has no value", async () => {
  const textarea = await mount();
  await type(
    textarea,
    "Hi {{contact.first_name}}, we emailed {{contact.email}}"
  );
  await submit();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(
    container.querySelector("[data-testid='merge-error']")?.textContent
  ).toContain("{{contact.email}}");
  // Pressing again changes nothing: the hole is still there.
  await submit();
  expect(fetchMock).not.toHaveBeenCalled();
  await type(textarea, "We emailed {{contact.email}}");
  await submit();
  expect(fetchMock).not.toHaveBeenCalled();
  // Editing clears the refusal; a clean message then sends as typed.
  await type(textarea, "Hi Thabo");
  expect(container.querySelector("[data-testid='merge-error']")).toBeNull();
  await submit();
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    contactId: "c1",
    body: "Hi Thabo",
  });
});

it("typed tags that resolve are filled in first, then sent as shown", async () => {
  const textarea = await mount();
  await type(
    textarea,
    "Hi {{ contact.first_name }}, {{user.name}} from {{business.name}}"
  );
  await submit();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(textarea.value).toBe("Hi Thabo, Anele from Velo Desk");
  await submit();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).body).toBe(
    "Hi Thabo, Anele from Velo Desk"
  );
});
