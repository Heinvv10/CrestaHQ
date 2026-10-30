// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingPage } from "@/types/booking";

/**
 * The text-reminders toggle in the booking-page editor: off for a new page
 * and for a page saved before it existed, opens on the stored value, and what
 * is ticked is what the save sends as `smsRemindersEnabled`.
 */

const ctx = vi.hoisted(() => ({ subAccount: {} as Record<string, unknown>, loading: false }));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccountId: "sa1", subAccount: ctx.subAccount, saPath: (p: string) => `/sa/sa1${p}`, loading: ctx.loading }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ agencyRole: null }) }));
vi.mock("@/hooks/use-agency-owner-uid", () => ({ useAgencyOwnerUid: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("firebase/firestore", () => ({ collection: vi.fn(), onSnapshot: () => () => {} }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: vi.fn() }));
vi.mock("@/components/settings/territory-select-field", () => ({ TerritorySelectField: () => null }));
vi.mock("@/components/booking/working-hours-grid", () => ({ WorkingHoursGrid: () => null }));
vi.mock("@/components/booking/date-overrides-editor", () => ({ DateOverridesEditor: () => null }));
vi.mock("@/components/booking/intake-field-builder", () => ({ IntakeFieldBuilder: () => null }));
vi.mock("@/components/booking/booking-help-dialog", () => ({ BookingHelpDialog: () => null }));
vi.mock("@/components/booking/team-booking-help-dialog", () => ({ TeamBookingHelpDialog: () => null }));
vi.mock("@/components/booking/calendar-type-section", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/booking/calendar-type-section")>()),
  CalendarTypeSection: () => null,
}));

const { BookingPageEditor } = await import("./booking-page-editor");
const { seedPage } = await import("@/test/booking-harness");

let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));

async function render(props: { mode: "new" } | { mode: "edit"; initial: BookingPage }) {
  await act(async () => root.render(createElement(BookingPageEditor, props)));
}
const stored = (over: Record<string, unknown> = {}) => seedPage("demo", over as never);
const toggle = () =>
  [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.includes("Text confirmation and reminders"))!
    .querySelector("input")!;

/** Saves the form and returns the request the editor made. */
async function save(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
  fetchMock.mockClear();
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  return { url, method: String(init.method), body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

beforeEach(() => {
  ctx.subAccount = { defaultPhoneCountry: "ZA" };
  ctx.loading = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("BookingPageEditor text reminders toggle", () => {
  it("a new page starts with it off and sends false", async () => {
    await render({ mode: "new" });
    expect(toggle().checked).toBe(false);
    const req = await save();
    expect(req.method).toBe("POST");
    expect(req.body.smsRemindersEnabled).toBe(false);
  });

  it("a page saved before the toggle existed opens with it off, and saving keeps it off", async () => {
    await render({ mode: "edit", initial: stored() });
    expect(toggle().checked).toBe(false);
    const req = await save();
    expect(req).toMatchObject({ method: "PATCH", url: "/api/sub-accounts/sa1/booking-pages/demo" });
    expect(req.body.smsRemindersEnabled).toBe(false);
  });

  it("opens on the stored value and sends it back unchanged", async () => {
    await render({ mode: "edit", initial: stored({ smsRemindersEnabled: true }) });
    expect(toggle().checked).toBe(true);
    expect((await save()).body.smsRemindersEnabled).toBe(true);
  });

  it("sends what was ticked, and false once it is cleared", async () => {
    await render({ mode: "edit", initial: stored() });
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(true);
    expect((await save()).body.smsRemindersEnabled).toBe(true);

    await act(async () => toggle().click());
    expect(toggle().checked).toBe(false);
    expect((await save()).body.smsRemindersEnabled).toBe(false);
  });

  it("is independent of the email reminders toggle", async () => {
    await render({ mode: "edit", initial: stored({ remindersEnabled: true }) });
    await act(async () => toggle().click());
    const body = (await save()).body;
    expect(body).toMatchObject({ remindersEnabled: true, smsRemindersEnabled: true });
  });
});

describe("the phone-country warning", () => {
  const warning = () => container.querySelector('[data-testid="sms-phone-country-warning"]');

  it("shows when texts are ticked and the workspace has no phone country, and says where to set it", async () => {
    ctx.subAccount = {};
    await render({ mode: "edit", initial: stored() });
    expect(warning()).toBeNull();
    await act(async () => toggle().click());
    expect(warning()?.textContent).toContain("Settings → Phone region");
    expect(warning()?.textContent).toContain("only US numbers");
  });

  it("is there from the start for a page that already has texts on", async () => {
    ctx.subAccount = { defaultPhoneCountry: null };
    await render({ mode: "edit", initial: stored({ smsRemindersEnabled: true }) });
    expect(warning()).not.toBeNull();
  });

  it("goes away when the toggle is cleared", async () => {
    ctx.subAccount = {};
    await render({ mode: "edit", initial: stored({ smsRemindersEnabled: true }) });
    await act(async () => toggle().click());
    expect(warning()).toBeNull();
  });

  it("is not shown when the workspace has a phone country", async () => {
    await render({ mode: "edit", initial: stored({ smsRemindersEnabled: true }) });
    expect(warning()).toBeNull();
  });

  it("is not shown while the workspace is still loading (it would read as unset)", async () => {
    ctx.subAccount = {};
    ctx.loading = true;
    await render({ mode: "edit", initial: stored({ smsRemindersEnabled: true }) });
    expect(warning()).toBeNull();
  });
});
