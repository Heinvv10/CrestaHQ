// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Manage dialog's X0 checkboxes (Agent monitors, Sell online, AI texts):
 * ticking one sends only that field on Save, and "AI texts" can be ticked on
 * only while its readiness checklist passes (and SMS AI auto-reply isn't
 * being switched off in the same save), but can always be unticked.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/agency/sub-account-billing-section", () => ({ SubAccountBillingSection: () => null }));
vi.mock("@/components/agency/sub-account-usage-section", () => ({ SubAccountUsageSection: () => null }));

import { SubAccountManageDialog } from "./sub-account-manage-dialog";
import type { SubAccountDoc } from "@/types";

const fetchMock = vi.fn();
type Check = { label: string; ok: boolean; fix: string };
let readinessChecks: Check[] = [];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  readinessChecks = [];
  fetchMock.mockReset().mockImplementation(async (url: string) =>
    ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/feature-gates")
          ? { ok: true }
          : url.endsWith("/ai-outbound-sms-readiness")
            ? { ready: readinessChecks.every((c) => c.ok), checks: readinessChecks }
            : { metaConfigured: true },
    }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const sub = (extra: Record<string, unknown>) => ({ id: "sa1", agencyId: "ag1", name: "Fixture", ...extra }) as unknown as SubAccountDoc;

async function open(doc: SubAccountDoc) {
  await act(async () => root.render(createElement(SubAccountManageDialog, { subAccount: doc, open: true, onOpenChange: () => undefined })));
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
function checkbox(title: string): HTMLInputElement {
  const label = [...document.body.querySelectorAll("label")].find((l) => l.textContent?.includes(title));
  if (!label) throw new Error(`no ${title} toggle`);
  return label.querySelector("input[type=checkbox]") as HTMLInputElement;
}
const saveButton = () => [...document.body.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent?.trim() ?? ""))!;
const patches = () =>
  fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith("/feature-gates") && (i as RequestInit)?.method === "PATCH").map(([, i]) => JSON.parse(String((i as RequestInit).body)));

describe.each([
  ["Agent monitors", "agentsEnabled", "agentsEnabledByAgency"],
  ["Sell online", "sellOnlineEnabled", "sellOnlineEnabledByAgency"],
])("%s checkbox", (title, key, field) => {
  it("reads the stored gate (unset reads as off)", async () => {
    await open(sub({}));
    expect(checkbox(title).checked).toBe(false);
  });

  it("sends only its own field when ticked", async () => {
    await open(sub({}));
    await act(async () => checkbox(title).click());
    await act(async () => saveButton().click());
    expect(patches()).toEqual([{ [key]: true }]);
  });

  it("sends false when a stored-on gate is unticked", async () => {
    await open(sub({ [field]: true }));
    expect(checkbox(title).checked).toBe(true);
    await act(async () => checkbox(title).click());
    await act(async () => saveButton().click());
    expect(patches()).toEqual([{ [key]: false }]);
  });
});

describe("AI texts checkbox", () => {
  const unmet = { label: "The SMS AI agent is switched on", ok: false, fix: "AI Agents → SMS: turn the channel on." };

  it("cannot be ticked on while a prerequisite is unmet, and lists it", async () => {
    readinessChecks = [{ label: "AI is configured on this deployment", ok: true, fix: "" }, unmet];
    await open(sub({}));
    expect(checkbox("AI texts").disabled).toBe(true);
    expect(document.body.textContent).toContain("The SMS AI agent is switched on. AI Agents → SMS: turn the channel on.");
  });

  it("can be ticked on once every prerequisite passes, sending only that field", async () => {
    readinessChecks = [{ ...unmet, ok: true }];
    await open(sub({}));
    expect(checkbox("AI texts").disabled).toBe(false);
    await act(async () => checkbox("AI texts").click());
    await act(async () => saveButton().click());
    expect(patches()).toEqual([{ aiOutboundSmsEnabled: true }]);
  });

  it("cannot be ticked on while SMS AI auto-reply is being switched off", async () => {
    readinessChecks = [{ ...unmet, ok: true }];
    await open(sub({}));
    await act(async () => checkbox("SMS AI auto-reply").click());
    expect(checkbox("AI texts").disabled).toBe(true);
  });

  it("can be unticked when stored on, sending only that field", async () => {
    await open(sub({ aiOutboundSmsEnabledByAgency: true }));
    expect(checkbox("AI texts").disabled).toBe(false);
    await act(async () => checkbox("AI texts").click());
    await act(async () => saveButton().click());
    expect(patches()).toEqual([{ aiOutboundSmsEnabled: false }]);
  });
});
