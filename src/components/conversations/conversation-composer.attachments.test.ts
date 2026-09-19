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

/** Storage PUTs that finish only when a test says so. */
let puts: Array<{ url: string; init: RequestInit; finish: (ok?: boolean) => void }>;

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

/** Lets the hook's async upload chain reach its next await. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

async function pickFile(name = "site.png", bytes = 3) {
  const input = q<HTMLInputElement>('[data-testid="whatsapp-attachment-input"]')!;
  const file = new File([new Uint8Array(bytes)], name, { type: "image/png" });
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function finishPut(i: number, ok = true) {
  await act(async () => puts[i]!.finish(ok));
  await flush();
}

/** The last call that was not part of an upload: the send itself. */
function lastSend() {
  return fetchMock.mock.calls.filter(
    (c) => c[0] !== "/api/comms/whatsapp/upload-url" && !String(c[0]).startsWith("https://storage.test/"),
  ).at(-1)!;
}

async function switchTo(channel: string) {
  await act(async () => q<HTMLButtonElement>(`[data-testid="channel-option-${channel}"]`)!.click());
}

async function clickSend() {
  await act(async () => sendButton().click());
}

function postedBody(): Record<string, unknown> {
  return JSON.parse(lastSend()[1].body as string);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  puts = [];
  let issued = 0;
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/comms/whatsapp/upload-url") {
      issued += 1;
      const n = issued;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          stagedId: `staged${n}`,
          uploadUrl: `https://storage.test/put/${n}`,
          contentLengthRange: "0,5000000",
        }),
      };
    }
    if (url.startsWith("https://storage.test/")) {
      return new Promise((resolve) =>
        puts.push({ url, init, finish: (ok = true) => resolve({ ok, status: ok ? 200 : 403 }) }),
      );
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
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

  it("disables Send while the file is still uploading, then sends it by staged id with the message", async () => {
    await mount();
    await type("here is the site");
    await pickFile();
    // Send now would post the caption alone, and the late read would attach
    // the file to whatever is typed next.
    expect(sendButton().disabled).toBe(true);
    expect(container.textContent).toContain("Uploading file");

    await finishPut(0);
    expect(sendButton().disabled).toBe(false);
    await clickSend();
    expect(postedBody().attachment).toEqual({
      stagedId: "staged1",
      filename: "site.png",
      contentType: "image/png",
    });
  });

  it("enables Send for a finished file with no text, and posts it with an empty body", async () => {
    await mount();
    expect(sendButton().disabled).toBe(true);
    await pickFile();
    // Still uploading: nothing to send yet.
    expect(sendButton().disabled).toBe(true);
    await finishPut(0);
    expect(sendButton().disabled).toBe(false);
    await clickSend();
    expect(lastSend()[0]).toBe("/api/comms/whatsapp/send");
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
    await finishPut(0);
    await switchTo("sms");
    expect(sendButton().disabled).toBe(true);
  });

  it("discards an upload that lands after a channel switch, even on switching back", async () => {
    await mount();
    await type("hello");
    await pickFile();
    await switchTo("sms");
    await finishPut(0);

    // The operator moved on before the file was ready. Coming back to
    // WhatsApp must not find it silently attached to the next message.
    await switchTo("whatsapp");
    expect(container.textContent).not.toContain("site.png");
    expect(container.textContent).not.toContain("Uploading file");
    await type("hello again");
    expect(sendButton().disabled).toBe(false);
    await clickSend();
    expect(lastSend()[0]).toBe("/api/comms/whatsapp/send");
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("does not revive a FINISHED attachment after a channel round-trip", async () => {
    // Attach, wander off to SMS without sending, come back and type something
    // unrelated: the file must be gone, not merely hidden while away.
    await mount();
    await pickFile();
    await finishPut(0);
    expect(container.textContent).toContain("site.png");
    await switchTo("sms");
    await switchTo("whatsapp");
    expect(container.textContent).not.toContain("site.png");
    await type("unrelated");
    await clickSend();
    expect(lastSend()[0]).toBe("/api/comms/whatsapp/send");
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("keeps the LATER pick when an earlier upload finishes last", async () => {
    await mount();
    await type("second one");
    await pickFile("first.png");
    await pickFile("second.png");
    await finishPut(1);
    await finishPut(0);
    expect(container.textContent).toContain("second.png");
    await clickSend();
    expect(postedBody().attachment).toMatchObject({ filename: "second.png" });
  });

  it("clears the attachment after a successful send, so the next message carries none", async () => {
    await mount();
    await type("with file");
    await pickFile();
    await finishPut(0);
    await clickSend();
    expect(postedBody()).toHaveProperty("attachment");
    await type("follow-up");
    await clickSend();
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("drops the attachment after a FAILED send and says to attach it again — the route deleted the upload", async () => {
    await mount();
    await type("with file");
    await pickFile();
    await finishPut(0);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "nope" }) });
    await clickSend();
    expect(container.textContent).not.toContain("site.png");
    // The text survives for the retry; only the file has to be picked again.
    expect(q<HTMLTextAreaElement>("textarea")!.value).toBe("with file");
  });

  it("refuses an empty file without uploading it", async () => {
    await mount();
    await pickFile("empty.png", 0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a refused PUT as a failed upload, not a file", async () => {
    await mount();
    await type("hi");
    await pickFile();
    await finishPut(0, false);
    expect(container.textContent).not.toContain("site.png");
    await clickSend();
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("counts the caption in code points: 600 emoji fit under Cloud's 1024", async () => {
    await mount();
    await pickFile();
    await finishPut(0);
    await type("😀".repeat(600));
    expect(sendButton().disabled).toBe(false);
  });

  it("never posts a WhatsApp attachment on another channel", async () => {
    await mount();
    await type("hi");
    await pickFile();
    await finishPut(0);
    await switchTo("sms");
    await type("hi");
    await clickSend();
    expect(lastSend()[0]).toBe("/api/comms/sms/send");
    expect(postedBody()).not.toHaveProperty("attachment");
  });

  it("blocks Send on a caption longer than the rail allows with a file", async () => {
    await mount();
    await pickFile();
    await finishPut(0);
    await type("x".repeat(1025));
    expect(sendButton().disabled).toBe(true);
    expect(container.textContent).toContain("1025 of 1024");
    await type("x".repeat(1024));
    expect(sendButton().disabled).toBe(false);
  });
});
