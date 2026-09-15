// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The composer's attachment WIRING, rendered. Every guard here is about what
 * reaches a customer's phone: a file on the wrong channel, a caption sent
 * without its file because Send beat the read, or a late read landing on the
 * next message. None of that is visible to a route test — the route only sees
 * the body the component chose to post.
 */

let subAccount: Record<string, unknown>;

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

/** FileReader whose reads finish only when a test says so. */
class FakeReader {
  static reads: FakeReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  file: File | null = null;
  readAsDataURL(file: File) {
    this.file = file;
    FakeReader.reads.push(this);
  }
  finish() {
    this.result = `data:${this.file!.type};base64,AAEC`;
    this.onload?.();
  }
}

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ConversationComposer, {
        contact: { id: "c1", subAccountId: "sa1", phone: "+27821234567", name: "C" } as never,
        availableChannels: ["whatsapp", "sms"],
        defaultChannel: "whatsapp",
      }),
    ),
  );
}

const q = <T extends Element>(sel: string) => container.querySelector<T>(sel);
const sendButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Send via"))!;

async function type(text: string) {
  const ta = q<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pickFile() {
  const input = q<HTMLInputElement>('[data-testid="whatsapp-attachment-input"]')!;
  const file = new File([new Uint8Array([1, 2, 3])], "site.png", { type: "image/png" });
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function switchTo(channel: string) {
  await act(async () => q<HTMLButtonElement>(`[data-testid="channel-option-${channel}"]`)!.click());
}

async function clickSend() {
  await act(async () => sendButton().click());
}

function postedBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("FileReader", FakeReader);
  FakeReader.reads = [];
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
  subAccount = { whatsappProvider: "cloud", whatsappEnabledByAgency: true };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ConversationComposer — WhatsApp attachments", () => {
  it("offers no picker on Twilio, whose rail cannot carry a file", async () => {
    subAccount = { whatsappProvider: "twilio", whatsappEnabledByAgency: true };
    await mount();
    expect(q('[data-testid="whatsapp-attachment-input"]')).toBeNull();
  });

  it("disables Send while the file is still being read, then sends it with the message", async () => {
    await mount();
    await type("here is the site");
    await pickFile();
    // Send now would post the caption alone, and the late read would attach
    // the file to whatever is typed next.
    expect(sendButton().disabled).toBe(true);
    expect(container.textContent).toContain("Reading file");

    await act(async () => FakeReader.reads[0]!.finish());
    expect(sendButton().disabled).toBe(false);
    await clickSend();
    expect(postedBody().attachment).toEqual({
      filename: "site.png",
      contentType: "image/png",
      dataBase64: "AAEC",
    });
  });

  it("discards a read that lands after a channel switch, even on switching back", async () => {
    await mount();
    await type("hello");
    await pickFile();
    await switchTo("sms");
    await act(async () => FakeReader.reads[0]!.finish());

    // The operator moved on before the file was ready. Coming back to
    // WhatsApp must not find it silently attached to the next message.
    await switchTo("whatsapp");
    expect(container.textContent).not.toContain("site.png");
    expect(container.textContent).not.toContain("Reading file");
    await type("hello again");
    expect(sendButton().disabled).toBe(false);
    await clickSend();
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/comms/whatsapp/send");
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("never posts a WhatsApp attachment on another channel", async () => {
    await mount();
    await type("hi");
    await pickFile();
    await act(async () => FakeReader.reads[0]!.finish());
    await switchTo("sms");
    await type("hi");
    await clickSend();
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/comms/sms/send");
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("blocks Send on a caption longer than the rail allows with a file", async () => {
    await mount();
    await pickFile();
    await act(async () => FakeReader.reads[0]!.finish());
    await type("x".repeat(1025));
    expect(sendButton().disabled).toBe(true);
    expect(container.textContent).toContain("1025 of 1024");
    await type("x".repeat(1024));
    expect(sendButton().disabled).toBe(false);
  });
});
