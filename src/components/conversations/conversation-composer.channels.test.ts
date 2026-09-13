// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Contact } from "@/types/contacts";
import type { ChannelOption } from "@/lib/conversations/channel-availability";
import type { WhatsappWindowView } from "@/hooks/use-whatsapp-window";

/**
 * SP2 T7/T8 at the composer seam: disabled channels carry their reason and
 * cannot be picked; the WhatsApp window state decides between free-form text
 * and the template picker. The window hook is stubbed — its inputs are the
 * pure `waWindowState`, tested on its own.
 */
const m = vi.hoisted(() => ({
  window: vi.fn<(contactId: string, active: boolean) => WhatsappWindowView | null>(),
}));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount: {}, subAccountId: "sa1" }),
}));
vi.mock("@/hooks/use-whatsapp-window", () => ({ useWhatsappWindow: m.window }));
vi.mock("./whatsapp-template-picker", () => ({
  WhatsappTemplatePicker: ({ provider }: { provider: string }) =>
    createElement("div", { "data-testid": "wa-template-picker" }, provider),
}));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

import { ConversationComposer } from "./conversation-composer";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  m.window.mockReset().mockReturnValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const contact = { id: "c1", phone: "+27820000000", email: "" } as Contact;
const opt = (channel: ChannelOption["channel"], reason: string | null = null): ChannelOption => ({
  channel,
  label: { email: "Email", sms: "SMS", whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" }[channel],
  available: reason === null,
  code: reason === null ? null : "not_connected",
  reason,
});
const OPTIONS = [
  opt("email", "No email address"),
  opt("sms", "Opted out of SMS"),
  opt("whatsapp"),
  opt("messenger", "Turned off by your agency"),
  opt("instagram", "Turned off by your agency"),
];

async function mount(defaultChannel: ChannelOption["channel"], options = OPTIONS) {
  await act(async () =>
    root.render(
      createElement(ConversationComposer, {
        contact,
        channelOptions: options,
        availableChannels: options.filter((o) => o.available).map((o) => o.channel),
        defaultChannel,
      }),
    ),
  );
}
const pill = (ch: string) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="channel-option-${ch}"]`)!;
const textarea = () => container.querySelector("textarea")!;
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

it("lists every channel; unavailable ones are disabled and say why", async () => {
  await mount("whatsapp");
  expect(pill("email").disabled).toBe(true);
  expect(pill("email").textContent).toBe("Email · No email address");
  expect(pill("sms").textContent).toBe("SMS · Opted out of SMS");
  expect(pill("messenger").disabled).toBe(true);
  expect(pill("whatsapp").disabled).toBe(false);
  expect(pill("whatsapp").getAttribute("aria-pressed")).toBe("true");
});

it("defaults to the first available channel when the last-used one is unavailable", async () => {
  await mount("email");
  expect(pill("whatsapp").getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("Send via WhatsApp");
});

it("window open: badge shown, free-form enabled, no template picker", async () => {
  m.window.mockReturnValue({
    provider: "cloud",
    state: { kind: "open", closesAt: new Date(), msLeft: (3 * 60 + 12) * 60_000 },
  });
  await mount("whatsapp");
  expect(m.window).toHaveBeenLastCalledWith("c1", true);
  expect(q("wa-window-state")?.textContent).toBe("Window open · closes in 3h 12m");
  expect(textarea().disabled).toBe(false);
  expect(q("wa-template-picker")).toBeNull();
});

it("window closed: free-form disabled and the template picker appears for the rail", async () => {
  m.window.mockReturnValue({ provider: "cloud", state: { kind: "closed", lastInboundAt: null } });
  await mount("whatsapp");
  expect(q("wa-window-state")?.textContent).toBe(
    "Window closed — only an approved template can be sent",
  );
  expect(textarea().disabled).toBe(true);
  expect(q("wa-template-picker")?.textContent).toBe("cloud");
});

it("bridge rail (exempt): no window UI and free-form stays enabled", async () => {
  m.window.mockReturnValue({ provider: "bridge", state: { kind: "exempt" } });
  await mount("whatsapp");
  expect(q("wa-window-state")).toBeNull();
  expect(q("wa-template-picker")).toBeNull();
  expect(textarea().disabled).toBe(false);
});

it("the window is only consulted for WhatsApp", async () => {
  m.window.mockReturnValue({ provider: "cloud", state: { kind: "closed", lastInboundAt: null } });
  const options = [opt("email", "No email address"), opt("sms"), opt("whatsapp"), opt("messenger", "x"), opt("instagram", "x")];
  await mount("sms", options);
  expect(m.window).toHaveBeenLastCalledWith("c1", false);
  expect(q("wa-template-picker")).toBeNull();
  expect(textarea().disabled).toBe(false);
});

it("with no reachable channel, still lists every reason", async () => {
  const options = OPTIONS.map((o) => (o.channel === "whatsapp" ? opt("whatsapp", "Not connected") : o));
  await mount("whatsapp", options);
  expect(pill("whatsapp").textContent).toBe("WhatsApp · Not connected");
  expect(container.textContent).toContain("No channel can reach this contact");
  expect(container.querySelector("form")).toBeNull();
});
