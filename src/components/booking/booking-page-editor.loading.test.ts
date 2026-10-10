// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the workspace doc is still loading every payment rail reads as off,
 * so the Payment section must not tell the operator to connect Stripe or
 * PayPal until it knows.
 */

const HINT = "Deposits need a payment method.";
const DESCRIPTION = "Connect Stripe or a PayPal.me username";

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    subAccount: null as Record<string, unknown> | null,
    saPath: (p: string) => `/sa/sa1${p}`,
    loading: true,
  },
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
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

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(BookingPageEditor, { mode: "new" }));
  });
}

function setCtx(subAccount: Record<string, unknown> | null, loading: boolean) {
  ctx.value = { ...ctx.value, subAccount, loading };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("BookingPageEditor payment section", () => {
  it("does not ask to connect a rail while the workspace is loading", async () => {
    setCtx(null, true);
    await render();
    expect(container.textContent).toContain("Require deposit to confirm the booking");
    expect(container.textContent).not.toContain(HINT);
    expect(container.textContent).not.toContain(DESCRIPTION);
  });

  it("asks to connect a rail once loaded with none connected", async () => {
    setCtx({ paymentsEnabledByAgency: true }, false);
    await render();
    expect(container.textContent).toContain(HINT);
    expect(container.textContent).toContain(DESCRIPTION);
  });

  it("offers deposits once loaded with a rail connected", async () => {
    setCtx({ paypalConfig: { username: "acme" } }, false);
    await render();
    expect(container.textContent).not.toContain(HINT);
    expect(container.textContent).not.toContain(DESCRIPTION);
    expect(container.textContent).toContain("Require a PayPal.me deposit");
  });
});
