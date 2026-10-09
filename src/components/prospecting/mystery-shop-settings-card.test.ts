// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Prospecting settings → the mystery-shop WhatsApp template: its name, its
 * Cloud status as a badge with the reason it can't send, a select of only the
 * two-variable templates, and the choice saved as `whatsappTemplateId` beside
 * (never inside) the enquiry wording.
 */

const sub = vi.hoisted(() => ({ prospectingMysteryShopTemplates: { call: "Hi", whatsappTemplateId: undefined as string | undefined } }));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount: { name: "Cresta HQ", ...sub }, subAccountId: "sa1", isAdmin: true }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MysteryShopSettingsCard } from "./mystery-shop-settings-card";

const variable = (position: number) => ({ position, label: `v${position}`, sampleValue: "x", source: "manual", mergeTag: null });
const tpl = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, displayName: name, body: "Do you offer {{1}} in {{2}}?", variables: [variable(1), variable(2)], status: "approved",
  contentSid: null, registrations: { cloud: { externalId: "m", status: "approved", rejectionReason: null } }, ...extra,
});
const TEMPLATES = [
  tpl("t1", "leadstack_speed_check", { registrations: { cloud: { externalId: "m", status: "rejected", rejectionReason: "INVALID_FORMAT" } } }),
  tpl("t2", "my_enquiry"),
  tpl("t3", "one_variable", { variables: [variable(1)], body: "Hi {{1}}" }),
];

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let container: HTMLDivElement;
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(MysteryShopSettingsCard)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sub.prospectingMysteryShopTemplates.whatsappTemplateId = undefined;
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "PUT" ? new Response(JSON.stringify({ ok: true })) : new Response(JSON.stringify({ templates: TEMPLATES })),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the mystery-shop WhatsApp template", () => {
  it("unset: the template named leadstack_speed_check, its Cloud status and why it can't send", async () => {
    await mount();
    expect(q("mystery-shop-wa-template-name")?.textContent).toBe("leadstack_speed_check");
    expect(q("mystery-shop-wa-template-status")?.textContent).toBe("rejected");
    expect(q("mystery-shop-wa-template-problem")?.textContent).toBe(
      "The WhatsApp template leadstack_speed_check was rejected: INVALID_FORMAT.",
    );
  });

  it("the select lists only two-variable templates; the choice saves as whatsappTemplateId beside the wording", async () => {
    await mount();
    const select = q("mystery-shop-wa-template-select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "t1", "t2"]);
    await act(async () => {
      select.value = "t2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(q("mystery-shop-wa-template-name")?.textContent).toBe("my_enquiry");
    expect(q("mystery-shop-wa-template-status")?.textContent).toBe("approved");
    expect(q("mystery-shop-wa-template-problem")).toBeNull();
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Save")!.click());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(put[1].body as string)).toEqual({ jobValues: {}, templates: { call: "Hi" }, whatsappTemplateId: "t2" });
  });

  it("a stored choice is shown, and the default saves as null", async () => {
    sub.prospectingMysteryShopTemplates.whatsappTemplateId = "t2";
    await mount();
    expect(q("mystery-shop-wa-template-name")?.textContent).toBe("my_enquiry");
    const select = q("mystery-shop-wa-template-select") as HTMLSelectElement;
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Save")!.click());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    // The stored choice never rides inside the wording (the PUT refuses unknown template keys).
    expect(JSON.parse(put[1].body as string)).toEqual({ jobValues: {}, templates: { call: "Hi" }, whatsappTemplateId: null });
  });

  it("no template by that name: says to create and submit it", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ templates: [] })));
    await mount();
    expect(q("mystery-shop-wa-template-problem")?.textContent).toBe(
      "The WhatsApp template leadstack_speed_check doesn't exist yet: create it and submit it to Meta.",
    );
  });
});
