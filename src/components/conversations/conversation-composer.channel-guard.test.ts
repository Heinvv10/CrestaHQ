// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The composer's own `channel === "whatsapp"` guard, tested apart from the
 * hook's keying. The hook is replaced by one that ALWAYS reports a finished
 * attachment, whatever the key — the failure the guard exists for. With the
 * guard in place, a non-WhatsApp channel must neither post the file nor be
 * blocked by the WhatsApp caption rule.
 */

let subAccount: Record<string, unknown>;

vi.mock("./whatsapp-attachment-picker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./whatsapp-attachment-picker")>();
  return {
    ...actual,
    useWhatsappAttachment: () => ({
      attachment: { stagedId: "staged1", filename: "site.png", contentType: "image/png" },
      uploading: false,
      pick: () => undefined,
      clear: () => undefined,
    }),
  };
});
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount, subAccountId: "sa1" }),
}));
vi.mock("@/hooks/use-whatsapp-window", () => ({ useWhatsappWindow: () => null }));
vi.mock("./use-merge-tag-composer", () => ({
  useMergeTagComposer: () => ({
    mergeContext: {},
    textareaRef: { current: null },
    reviewConfigured: false,
    insertReviewMessage: () => undefined,
    textareaProps: {},
    insertIntoBody: () => undefined,
    applySnippetSubject: () => undefined,
    blockSend: () => false,
    reset: () => undefined,
    notice: null,
  }),
}));
vi.mock("./composer-inserts", () => ({ ComposerInserts: () => null }));
vi.mock("./send-later-menu", () => ({
  SendLaterMenu: ({ children }: { children: unknown }) => children,
}));
vi.mock("./internal-note-composer", () => ({
  ComposerModeToggle: () => null,
  InternalNoteComposer: () => null,
}));
vi.mock("./whatsapp-template-picker", () => ({ WhatsappTemplatePicker: () => null }));

import { ConversationComposer } from "./conversation-composer";

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
  subAccount = { whatsappProvider: "cloud", whatsappEnabledByAgency: true };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ConversationComposer, {
        contact: { id: "c1", subAccountId: "sa1", phone: "+27821234567", name: "C" } as never,
        availableChannels: ["whatsapp", "sms"],
        defaultChannel: "sms",
      }),
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function type(text: string) {
  const ta = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const sendButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Send via"))!;

it("posts no attachment on SMS even when the hook reports one", async () => {
  await type("hello");
  await act(async () => sendButton().click());
  expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/comms/sms/send");
  expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string)).not.toHaveProperty("attachment");
});

it("does not apply the WhatsApp caption limit to an SMS", async () => {
  await type("x".repeat(1100));
  expect(sendButton().disabled).toBe(false);
  expect(container.textContent).not.toContain("characters allowed");
});
