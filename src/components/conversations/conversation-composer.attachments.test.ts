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
  finish(result = `data:${this.file!.type};base64,AAEC`) {
    this.result = result;
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

async function pickFile(name = "site.png", bytes = 3) {
  const input = q<HTMLInputElement>('[data-testid="whatsapp-attachment-input"]')!;
  const file = new File([new Uint8Array(bytes)], name, { type: "image/png" });
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

  it("enables Send for a finished file with no text, and posts it with an empty body", async () => {
    await mount();
    expect(sendButton().disabled).toBe(true);
    await pickFile();
    // Still reading: nothing to send yet.
    expect(sendButton().disabled).toBe(true);
    await act(async () => FakeReader.reads[0]!.finish());
    expect(sendButton().disabled).toBe(false);
    await clickSend();
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/comms/whatsapp/send");
    expect(postedBody()).toMatchObject({ body: "", attachment: { filename: "site.png" } });
  });

  it("keeps Send disabled with no text and no file", async () => {
    await mount();
    await type("   ");
    expect(sendButton().disabled).toBe(true);
    await clickSend();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let a WhatsApp file enable an empty send on another channel", async () => {
    await mount();
    await pickFile();
    await act(async () => FakeReader.reads[0]!.finish());
    await switchTo("sms");
    expect(sendButton().disabled).toBe(true);
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

  it("does not revive a FINISHED attachment after a channel round-trip", async () => {
    // Attach, wander off to SMS without sending, come back and type something
    // unrelated: the file must be gone, not merely hidden while away.
    await mount();
    await pickFile();
    await act(async () => FakeReader.reads[0]!.finish());
    expect(container.textContent).toContain("site.png");
    await switchTo("sms");
    await switchTo("whatsapp");
    expect(container.textContent).not.toContain("site.png");
    await type("unrelated");
    await clickSend();
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/comms/whatsapp/send");
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("keeps the LATER pick when an earlier read finishes last", async () => {
    await mount();
    await type("second one");
    await pickFile("first.png");
    await pickFile("second.png");
    await act(async () => FakeReader.reads[1]!.finish());
    await act(async () => FakeReader.reads[0]!.finish());
    expect(container.textContent).toContain("second.png");
    await clickSend();
    expect(postedBody().attachment).toMatchObject({ filename: "second.png" });
  });

  it("clears the attachment after a successful send, so the next message carries none", async () => {
    await mount();
    await type("with file");
    await pickFile();
    await act(async () => FakeReader.reads[0]!.finish());
    await clickSend();
    expect(postedBody()).toHaveProperty("attachment");
    await type("follow-up");
    await clickSend();
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("keeps the attachment after a FAILED send, so the operator can retry it", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "nope" }) });
    await mount();
    await type("with file");
    await pickFile();
    await act(async () => FakeReader.reads[0]!.finish());
    await clickSend();
    expect(container.textContent).toContain("site.png");
  });

  it("refuses an empty file without reading it", async () => {
    await mount();
    await pickFile("empty.png", 0);
    expect(FakeReader.reads).toHaveLength(0);
  });

  it("treats a bare `data:` read result as a failed read, not a file", async () => {
    await mount();
    await type("hi");
    await pickFile();
    await act(async () => FakeReader.reads[0]!.finish("data:"));
    expect(container.textContent).not.toContain("site.png");
    await clickSend();
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("treats a read with nothing after the comma as a failed read", async () => {
    await mount();
    await type("hi");
    await pickFile();
    await act(async () => FakeReader.reads[0]!.finish("data:application/pdf;base64,"));
    expect(container.textContent).not.toContain("site.png");
    await clickSend();
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("counts the caption in code points: 600 emoji fit under Cloud's 1024", async () => {
    await mount();
    await pickFile();
    await act(async () => FakeReader.reads[0]!.finish());
    await type("😀".repeat(600));
    expect(sendButton().disabled).toBe(false);
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
