// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingPage } from "@/types/booking";

/**
 * The Style picker in the booking-page editor: the stored preset opens
 * chosen, and what is picked is what the save sends as `themePreset`.
 */

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccountId: "sa1", subAccount: {}, saPath: (p: string) => `/sa/sa1${p}`, loading: false }),
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
const stored = (themePreset?: unknown) => seedPage("demo", (themePreset === undefined ? {} : { themePreset }) as never);
const card = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label))!;
const chosen = () =>
  [...container.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent?.replace(/(Brand default|Clean|Midnight|Noir Lime|Sunset|Ocean).*/, "$1"));

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

describe("BookingPageEditor style preset", () => {
  it("a new page starts with no preset and sends none", async () => {
    await render({ mode: "new" });
    expect(chosen()).toEqual(["Brand default"]);
    const req = await save();
    expect(req.method).toBe("POST");
    expect(req.body.themePreset).toBeNull();
  });

  it("a page saved before presets opens with none, and saving it sends none", async () => {
    await render({ mode: "edit", initial: stored() });
    expect(chosen()).toEqual(["Brand default"]);
    const req = await save();
    expect(req).toMatchObject({ method: "PATCH", url: "/api/sub-accounts/sa1/booking-pages/demo" });
    expect(req.body.themePreset).toBeNull();
  });

  it("opens on the stored preset and sends it back unchanged", async () => {
    await render({ mode: "edit", initial: stored("ocean") });
    expect(chosen()).toEqual(["Ocean"]);
    expect((await save()).body.themePreset).toBe("ocean");
  });

  it("sends the preset that was picked, and null once it is cleared", async () => {
    await render({ mode: "edit", initial: stored("ocean") });
    await act(async () => card("Noir Lime").click());
    expect(chosen()).toEqual(["Noir Lime"]);
    expect((await save()).body.themePreset).toBe("noir-lime");

    await act(async () => card("Brand default").click());
    expect(chosen()).toEqual(["Brand default"]);
    expect((await save()).body.themePreset).toBeNull();
  });

  it("opens an unrecognised stored preset as none, so the page can still be saved", async () => {
    await render({ mode: "edit", initial: stored("bogus") });
    expect(chosen()).toEqual(["Brand default"]);
    expect((await save()).body.themePreset).toBeNull();
  });
});
