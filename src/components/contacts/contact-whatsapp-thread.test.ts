// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The contact-profile WhatsApp composer must pick its rail the way the send
 * route does — through the sender registry — or it offers a file picker for
 * a rail the send does not go out on (and hides one on a rail that would
 * take the file). Plus the same read race the inbox composer guards.
 */

let subAccount: Record<string, unknown>;

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount, subAccountId: "sa1" }),
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  collection: () => ({}),
  doc: () => ({}),
  orderBy: () => ({}),
  query: () => ({}),
  serverTimestamp: () => null,
  setDoc: async () => undefined,
  // One recent inbound, already read, so a Meta rail's window is open.
  onSnapshot: (_q: unknown, next: (snap: unknown) => void) => {
    next({
      docs: [
        {
          id: "m1",
          data: () => ({ direction: "inbound", body: "hi", createdAt: new Date(), readAt: new Date() }),
        },
      ],
    });
    return () => undefined;
  },
}));
vi.mock("@/components/contacts/whatsapp-template-sender", () => ({
  WhatsappTemplateSender: () => null,
}));

import { ContactWhatsappThread } from "./contact-whatsapp-thread";

/** Storage PUTs that finish only when a test says so. */
let puts: Array<{ finish: (ok?: boolean) => void }>;

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ContactWhatsappThread, {
        contact: { id: "c1", subAccountId: "sa1", phone: "+27821234567", name: "C" } as never,
      }),
    ),
  );
}

const picker = () => container.querySelector<HTMLInputElement>('[data-testid="whatsapp-attachment-input"]');
const sendButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Send")!;

const sender = (provider: string) => ({
  id: `s-${provider}`,
  label: provider,
  provider,
  phoneNumber: "+27110000000",
  isDefault: true,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  puts = [];
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/comms/whatsapp/upload-url") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ stagedId: "staged1", uploadUrl: "https://storage.test/put/1" }),
      };
    }
    if (url.startsWith("https://storage.test/")) {
      return new Promise((resolve) =>
        puts.push({ finish: (ok = true) => resolve({ ok, status: ok ? 200 : 403 }) }),
      );
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

async function typeBody(text: string) {
  const ta = container.querySelector("textarea")!;
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

async function finishPut(i: number) {
  await act(async () => puts[i]!.finish());
  await flush();
}

/** Calls to the send route — uploads excluded. */
const sends = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/comms/whatsapp/send");

async function pick() {
  const input = picker()!;
  await act(async () => {
    Object.defineProperty(input, "files", {
      value: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

/** Submits the form directly — the path a disabled button does not guard. */
async function submitForm() {
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

const posted = () => JSON.parse(sends().at(-1)![1].body as string);

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ContactWhatsappThread — rail and attachments", () => {
  it("offers the picker when the registry default is Cloud, even if whatsappProvider says twilio", async () => {
    subAccount = { whatsappProvider: "twilio", whatsappSenders: [sender("cloud")] };
    await mount();
    expect(picker()).not.toBeNull();
  });

  it("hides the picker when the registry default is Twilio, even if whatsappProvider says cloud", async () => {
    subAccount = { whatsappProvider: "cloud", whatsappSenders: [sender("twilio")] };
    await mount();
    expect(picker()).toBeNull();
  });

  it("disables Send while the file is uploading", async () => {
    subAccount = { whatsappProvider: "cloud" };
    await mount();
    const ta = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "photo");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(sendButton().disabled).toBe(false);

    const input = picker()!;
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })],
        configurable: true,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(sendButton().disabled).toBe(true);
    await finishPut(0);
    expect(sendButton().disabled).toBe(false);
    expect(container.textContent).toContain("a.png");
  });

  it("enables Send for a finished file with no text, and posts it with an empty body", async () => {
    subAccount = { whatsappProvider: "cloud" };
    await mount();
    expect(sendButton().disabled).toBe(true);
    await pick();
    expect(sendButton().disabled).toBe(true);
    await finishPut(0);
    expect(sendButton().disabled).toBe(false);
    await submitForm();
    expect(posted()).toMatchObject({ body: "", attachment: { filename: "a.png" } });
  });

  it("keeps Send disabled and refuses a submit with no text and no file", async () => {
    subAccount = { whatsappProvider: "cloud" };
    await mount();
    await typeBody("   ");
    expect(sendButton().disabled).toBe(true);
    await submitForm();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a form submit with no text while the file is still uploading", async () => {
    subAccount = { whatsappProvider: "cloud" };
    await mount();
    await pick();
    await submitForm();
    expect(sends()).toHaveLength(0);
  });

  it("refuses a form submit while the file is still uploading", async () => {
    subAccount = { whatsappProvider: "cloud" };
    await mount();
    await typeBody("photo");
    await pick();
    await submitForm();
    expect(sends()).toHaveLength(0);
  });

  it("refuses a form submit when the sender cannot be resolved", async () => {
    // A registry sender asking for its own credentials is refused by the
    // route; the composer must not post it either.
    subAccount = { whatsappSenders: [{ ...sender("bridge"), credentialsId: "x" }] };
    await mount();
    await typeBody("hello");
    expect(sendButton().disabled).toBe(true);
    await submitForm();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards a picked file on entering template mode, so Back to message does not bring it back", async () => {
    subAccount = { whatsappProvider: "cloud" };
    await mount();
    await pick();
    await finishPut(0);
    expect(container.textContent).toContain("a.png");
    const button = (label: string) =>
      [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
    await act(async () => button("Send template").click());
    await act(async () => button("Back to message").click());
    expect(container.textContent).not.toContain("a.png");
    await typeBody("unrelated");
    await submitForm();
    expect(posted()).not.toHaveProperty("attachment");
  });

  it("clears the attachment after a successful send", async () => {
    subAccount = { whatsappProvider: "cloud" };
    await mount();
    await typeBody("photo");
    await pick();
    await finishPut(0);
    await submitForm();
    expect(posted()).toHaveProperty("attachment");
    await typeBody("follow-up");
    await submitForm();
    expect(posted()).not.toHaveProperty("attachment");
  });
});
